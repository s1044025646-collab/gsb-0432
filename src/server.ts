// HTTP API：导入程序、校验、解释、模态查询、总长度、导出、历史。
import * as http from "node:http";
import { Store } from "./store";
import { interpret, DEFAULT_LIMITS, Limits } from "./gcode";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

function sendError(res: http.ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

function parsePaging(url: URL, limits: Limits): { offset: number; limit: number } {
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  let size = Number(url.searchParams.get("size") ?? "100") || 100;
  size = Math.min(Math.max(1, size), limits.maxPageSize);
  return { offset: (page - 1) * size, limit: size };
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";
      if (method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, { ok: true });
      }
      if (method === "POST" && url.pathname === "/programs") {
        const body = JSON.parse(await readBody(req));
        if (typeof body.source !== "string" || body.source.length === 0) {
          return sendError(res, 400, "VALIDATION", "请求体必须包含非空字符串字段 source");
        }
        const name = typeof body.name === "string" && body.name ? body.name : "未命名程序";
        const r = store.createProgram(name, body.source);
        return sendJson(res, 201, {
          programId: r.programId,
          versionId: r.versionId,
          versionNo: r.versionNo,
          analysisId: r.analysisId,
          status: r.result.ok ? "ok" : "error",
          diagnostics: r.result.diagnostics,
          totalLength: r.result.ok ? r.result.totalLength : null,
        });
      }
      if (method === "POST" && url.pathname === "/validate") {
        const body = JSON.parse(await readBody(req));
        if (typeof body.source !== "string") {
          return sendError(res, 400, "VALIDATION", "请求体必须包含字符串字段 source");
        }
        const result = interpret(body.source, store.tolerances, store.limits);
        return sendJson(res, 200, {
          ok: result.ok,
          diagnostics: result.diagnostics,
          segmentCount: result.ok ? result.segments.length : 0,
          totalLength: result.ok ? result.totalLength : null,
        });
      }
      if (method === "GET" && url.pathname === "/programs") {
        return sendJson(res, 200, { programs: store.listPrograms() });
      }
      if (method === "GET" && parts[0] === "programs" && parts.length === 2) {
        const id = Number(parts[1]);
        const versions = store.listVersions(id);
        if ((versions as unknown[]).length === 0) return sendError(res, 404, "NOT_FOUND", `程序 ${id} 不存在`);
        return sendJson(res, 200, { programId: id, versions });
      }
      if (method === "POST" && parts[0] === "programs" && parts[2] === "versions") {
        const id = Number(parts[1]);
        const body = JSON.parse(await readBody(req));
        if (typeof body.source !== "string" || body.source.length === 0) {
          return sendError(res, 400, "VALIDATION", "请求体必须包含非空字符串字段 source");
        }
        try {
          const r = store.addVersion(id, body.source);
          return sendJson(res, 201, {
            programId: r.programId,
            versionId: r.versionId,
            versionNo: r.versionNo,
            analysisId: r.analysisId,
            status: r.result.ok ? "ok" : "error",
            diagnostics: r.result.diagnostics,
            totalLength: r.result.ok ? r.result.totalLength : null,
          });
        } catch {
          return sendError(res, 404, "NOT_FOUND", `程序 ${id} 不存在`);
        }
      }
      if (method === "GET" && parts[0] === "versions" && parts[2] === "report") {
        const v = store.getVersion(Number(parts[1]));
        if (!v) return sendError(res, 404, "NOT_FOUND", `版本 ${parts[1]} 不存在`);
        const a = store.latestAnalysis(v.id);
        const { offset, limit } = parsePaging(url, store.limits);
        const segs = a && a.status === "ok" ? store.getSegments(a.id, offset, limit) : { rows: [], total: 0 };
        return sendJson(res, 200, {
          version: v,
          analysis: a ? { ...a, diagnostics: JSON.parse(a.diagnostics) } : null,
          segments: segs.rows,
          segmentTotal: segs.total,
          page: { offset, limit },
        });
      }
      if (method === "GET" && parts[0] === "versions" && parts[2] === "segments") {
        const v = store.getVersion(Number(parts[1]));
        if (!v) return sendError(res, 404, "NOT_FOUND", `版本 ${parts[1]} 不存在`);
        const a = store.latestAnalysis(v.id);
        if (!a || a.status !== "ok") {
          return sendError(res, 409, "ANALYSIS_FAILED", "该版本分析未成功，无完整刀路段");
        }
        const { offset, limit } = parsePaging(url, store.limits);
        const { rows, total } = store.getSegments(a.id, offset, limit);
        if (url.searchParams.get("format") === "csv") {
          const header = "seq,line,type,sx,sy,ex,ey,cx,cy,direction,sweep,length";
          const csvRows = (rows as Record<string, unknown>[]).map((r) =>
            [r.seq, r.line, r.type, r.sx, r.sy, r.ex, r.ey, r.cx ?? "", r.cy ?? "", r.direction ?? "", r.sweep ?? "", r.length].join(",")
          );
          res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" });
          return res.end([header, ...csvRows].join("\n"));
        }
        return sendJson(res, 200, { segments: rows, total, page: { offset, limit } });
      }
      if (method === "GET" && parts[0] === "versions" && parts[2] === "modal") {
        const v = store.getVersion(Number(parts[1]));
        if (!v) return sendError(res, 404, "NOT_FOUND", `版本 ${parts[1]} 不存在`);
        const a = store.latestAnalysis(v.id);
        if (!a || a.status !== "ok") {
          return sendError(res, 409, "ANALYSIS_FAILED", "该版本分析未成功，无模态记录");
        }
        const line = Number(url.searchParams.get("line"));
        if (!Number.isInteger(line) || line < 1) {
          return sendError(res, 400, "VALIDATION", "查询参数 line 必须为正整数");
        }
        const row = store.getModalByLine(a.id, line) as
          | { line: number; source: string; before_state: string; after_state: string; segment_seq: number | null }
          | undefined;
        if (!row) return sendError(res, 404, "NOT_FOUND", `第 ${line} 行无模态记录（空行/注释行或无此行）`);
        return sendJson(res, 200, {
          line: row.line,
          source: row.source,
          before: JSON.parse(row.before_state),
          after: JSON.parse(row.after_state),
          segmentSeq: row.segment_seq,
        });
      }
      if (method === "GET" && parts[0] === "versions" && parts[2] === "length") {
        const v = store.getVersion(Number(parts[1]));
        if (!v) return sendError(res, 404, "NOT_FOUND", `版本 ${parts[1]} 不存在`);
        const a = store.latestAnalysis(v.id);
        if (!a || a.status !== "ok") {
          return sendError(res, 409, "ANALYSIS_FAILED", "该版本分析未成功，无总长度");
        }
        return sendJson(res, 200, { versionId: v.id, totalLength: a.total_length, unit: "mm" });
      }
      sendError(res, 404, "NOT_FOUND", `未知路由 ${method} ${url.pathname}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      sendError(res, 500, "INTERNAL", msg);
    }
  });
}

export function startServer(port = 0, dbPath?: string): Promise<{ server: http.Server; port: number }> {
  const store = new Store({ dbPath, limits: DEFAULT_LIMITS });
  const server = createServer(store);
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      resolve({ server, port: actual });
    });
  });
}

if (require.main === module) {
  const argPort = Number(process.argv[2] ?? "0");
  startServer(Number.isFinite(argPort) ? argPort : 0).then(({ port }) => {
    console.log(`G-code 解释服务已启动: http://127.0.0.1:${port}`);
  });
}
