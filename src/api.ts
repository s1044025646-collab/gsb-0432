import http from "node:http";
import net from "node:net";
import { Store } from "./db.js";
import { interpret } from "./interpreter.js";
import { CONFIG } from "./config.js";

function json(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

function parsePage(url: URL) {
  const limitRaw = url.searchParams.get("limit");
  const pageRaw = url.searchParams.get("page");
  let limit = limitRaw ? Number(limitRaw) : CONFIG.PAGE_LIMIT_DEFAULT;
  const page = pageRaw ? Number(pageRaw) : 1;
  if (!Number.isInteger(limit) || limit < 1) limit = CONFIG.PAGE_LIMIT_DEFAULT;
  limit = Math.min(limit, CONFIG.PAGE_LIMIT_MAX);
  const safePage = Number.isInteger(page) && page >= 1 ? page : 1;
  return { limit, offset: (safePage - 1) * limit, page: safePage };
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      // POST /programs {name, source}
      if (method === "POST" && url.pathname === "/programs") {
        const body = JSON.parse(await readBody(req));
        if (typeof body.name !== "string" || typeof body.source !== "string") {
          return json(res, 400, { code: "E_BAD_REQUEST", message: "需要 name 与 source 字符串字段" });
        }
        const { programId, versionId } = store.createProgram(body.name, body.source);
        return json(res, 201, { programId, versionId });
      }

      // GET /programs
      if (method === "GET" && url.pathname === "/programs") {
        return json(res, 200, { programs: store.listPrograms() });
      }

      // POST /programs/:id/versions {source}
      if (method === "POST" && parts[0] === "programs" && parts[2] === "versions") {
        const programId = Number(parts[1]);
        const body = JSON.parse(await readBody(req));
        if (typeof body.source !== "string") {
          return json(res, 400, { code: "E_BAD_REQUEST", message: "需要 source 字符串字段" });
        }
        try {
          const versionId = store.addVersion(programId, body.source);
          return json(res, 201, { programId, versionId });
        } catch {
          return json(res, 404, { code: "E_NOT_FOUND", message: `程序 ${programId} 不存在` });
        }
      }

      // GET /programs/:id/versions
      if (method === "GET" && parts[0] === "programs" && parts[2] === "versions") {
        return json(res, 200, { versions: store.listVersions(Number(parts[1])) });
      }

      // /versions/:id/...
      if (parts[0] === "versions") {
        const versionId = Number(parts[1]);
        const version = store.getVersion(versionId) as any;
        if (!version) {
          return json(res, 404, { code: "E_NOT_FOUND", message: `版本 ${versionId} 不存在` });
        }
        const sub = parts[2];

        // POST /versions/:id/analyze — 解释并保存报告（非法时只存诊断不存段）
        if (method === "POST" && sub === "analyze") {
          const result = interpret(version.source_text);
          store.saveReport(versionId, result);
          return json(res, result.ok ? 200 : 422, result);
        }

        // POST /versions/:id/validate — 只校验不落库
        if (method === "POST" && sub === "validate") {
          const result = interpret(version.source_text);
          return json(res, result.ok ? 200 : 422, {
            ok: result.ok,
            diagnostics: result.diagnostics,
          });
        }

        // GET /versions/:id/report
        if (method === "GET" && sub === "report") {
          const report = store.getReport(versionId);
          if (!report) return json(res, 404, { code: "E_NOT_FOUND", message: "尚未分析" });
          return json(res, 200, report);
        }

        // GET /versions/:id/segments?page=&limit=
        if (method === "GET" && sub === "segments") {
          const { limit, offset, page } = parsePage(url);
          const total = store.countSegments(versionId);
          return json(res, 200, {
            total,
            page,
            limit,
            segments: store.getSegments(versionId, limit, offset),
          });
        }

        // GET /versions/:id/length
        if (method === "GET" && sub === "length") {
          const report = store.getReport(versionId) as any;
          if (!report || report.status !== "ok") {
            return json(res, 409, { code: "E_BAD_REQUEST", message: "无成功分析报告" });
          }
          return json(res, 200, { totalLength: report.total_length });
        }

        // GET /versions/:id/modal?line=N — 按行查看前后模态（即时解释，不落库）
        if (method === "GET" && sub === "modal") {
          const lineNo = Number(url.searchParams.get("line"));
          const result = interpret(version.source_text);
          if (!url.searchParams.has("line")) {
            return json(res, 200, { trace: result.trace });
          }
          const t = result.trace.find((x) => x.line === lineNo);
          if (!t) return json(res, 404, { code: "E_NOT_FOUND", message: `行 ${lineNo} 不存在` });
          return json(res, 200, t);
        }

        // GET /versions/:id/source
        if (method === "GET" && sub === "source") {
          return json(res, 200, version);
        }
      }

      json(res, 404, { code: "E_NOT_FOUND", message: "路由不存在" });
    } catch (e) {
      json(res, 500, { code: "E_INTERNAL", message: String(e) });
    }
  });
}

export function findFreePort(preferred = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(preferred, () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.on("error", reject);
  });
}

export async function startServer(
  store: Store,
  port?: number
): Promise<{ server: http.Server; port: number }> {
  const p = port ?? (await findFreePort());
  const server = createServer(store);
  await new Promise<void>((resolve) => server.listen(p, resolve));
  return { server, port: p };
}
