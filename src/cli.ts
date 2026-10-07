#!/usr/bin/env node
import fs from "node:fs";
import { Store } from "./db.js";
import { interpret } from "./interpreter.js";
import { startServer } from "./api.js";
import { CONFIG } from "./config.js";

const store = new Store(process.env.GCODE_DATA_DIR ?? CONFIG.DATA_DIR);

function out(x: unknown) {
  console.log(JSON.stringify(x, null, 2));
}

function fail(msg: string): never {
  console.error(`错误: ${msg}`);
  process.exit(1);
}

function readSource(args: string[]): string {
  const file = args[0];
  if (!file) fail("缺少 G-code 文件路径");
  return fs.readFileSync(file, "utf-8");
}

const [cmd, ...args] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case "import": {
      // import <file> [name]
      const source = readSource(args);
      const name = args[1] ?? args[0];
      const r = store.createProgram(name, source);
      out({ message: "已导入", ...r });
      break;
    }
    case "version": {
      // version <programId> <file> — 为已有程序另建版本
      const source = readSource(args.slice(1));
      const versionId = store.addVersion(Number(args[0]), source);
      out({ message: "已创建新版本", programId: Number(args[0]), versionId });
      break;
    }
    case "validate": {
      const result = interpret(readSource(args));
      out({ ok: result.ok, diagnostics: result.diagnostics });
      if (!result.ok) process.exit(2);
      break;
    }
    case "interpret": {
      const result = interpret(readSource(args));
      out(result);
      if (!result.ok) process.exit(2);
      break;
    }
    case "analyze": {
      // analyze <versionId> — 解释并保存报告
      const v = store.getVersion(Number(args[0])) as any;
      if (!v) fail("版本不存在");
      const result = interpret(v.source_text);
      store.saveReport(v.id, result);
      out({ saved: true, ok: result.ok, diagnostics: result.diagnostics, totalLength: result.ok ? result.totalLength : null });
      if (!result.ok) process.exit(2);
      break;
    }
    case "modal": {
      // modal <file> [line]
      const result = interpret(readSource(args));
      if (args[1]) {
        const t = result.trace.find((x) => x.line === Number(args[1]));
        if (!t) fail("行不存在");
        out(t);
      } else {
        out(result.trace);
      }
      break;
    }
    case "length": {
      // length <versionId>
      const r = store.getReport(Number(args[0])) as any;
      if (!r || r.status !== "ok") fail("无成功分析报告");
      out({ totalLength: r.total_length });
      break;
    }
    case "export": {
      // export <versionId> [page] [limit]
      const limit = Math.min(Number(args[2]) || CONFIG.PAGE_LIMIT_DEFAULT, CONFIG.PAGE_LIMIT_MAX);
      const page = Number(args[1]) || 1;
      out({
        total: store.countSegments(Number(args[0])),
        page,
        limit,
        segments: store.getSegments(Number(args[0]), limit, (page - 1) * limit),
      });
      break;
    }
    case "history": {
      // history [programId]
      if (args[0]) out(store.listVersions(Number(args[0])));
      else out(store.listPrograms());
      break;
    }
    case "serve": {
      // serve [port]
      const port = args[0] ? Number(args[0]) : undefined;
      const { port: p } = await startServer(store, port);
      console.log(`API 服务已启动: http://localhost:${p}`);
      break;
    }
    case "demo": {
      runDemo();
      break;
    }
    default:
      console.log(`用法: node dist/cli.js <命令>
  import <file> [name]        导入程序（创建程序与版本1）
  version <programId> <file>  为程序另建新版本
  validate <file>             校验程序
  interpret <file>            解释全部运动并输出段列表
  analyze <versionId>         解释并保存报告到数据库
  modal <file> [line]         查看每行前后模态状态
  length <versionId>          查询总长度
  export <versionId> [page] [limit]  导出段列表（分页）
  history [programId]         读取程序/版本历史
  serve [port]                启动 API 服务（默认自动选空闲端口）
  demo                        运行演示`);
  }
}

function runDemo() {
  const ccw = "G1 X1 Y0\nG3 X0 Y1 I-1 J0\n";
  const cw = "G1 X1 Y0\nG2 X0 Y1 I-1 J0\n";
  for (const [label, src] of [["G3 逆时针", ccw], ["G2 顺时针", cw]] as const) {
    const r = interpret(src);
    const arc = r.segments[1];
    console.log(`\n== ${label} ==`);
    console.log(`圆心 (${arc.center!.x}, ${arc.center!.y}) 半径 ${arc.radius}`);
    console.log(`扫角 ${arc.sweep} rad (${(arc.sweep! * 180) / Math.PI}°) 弧长 ${arc.length}`);
    console.log(`期望: G3 → π/2 ≈ ${Math.PI / 2}; G2 → 3π/2 ≈ ${(3 * Math.PI) / 2}`);
  }
  console.log("\n== 非法行拒绝 ==");
  const bad = interpret("G1 X1\nM3 S1000\n");
  console.log(`ok=${bad.ok} 诊断: ${bad.diagnostics[0].code} 第${bad.diagnostics[0].line}行: ${bad.diagnostics[0].message}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    if (cmd !== "serve") store.close();
  });
