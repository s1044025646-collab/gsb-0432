// CLI：import / validate / report / modal / length / export / list / versions / serve / demo
import * as fs from "node:fs";
import * as path from "node:path";
import { Store } from "./store";
import { interpret } from "./gcode";
import { startServer } from "./server";

const DEFAULT_DB = path.join(process.cwd(), "data", "gcode.db");

function usage(): void {
  console.log(`用法: node dist/cli.js <命令> [参数]

命令:
  serve [--port N] [--db PATH]        启动 HTTP API（默认端口 0 = 自动选空闲端口）
  import <file> [--name N] [--db P]   导入程序文件并分析，另存为新程序
  validate <file>                     仅校验文件，不写入数据库
  report <versionId> [--db P]         查看某版本的完整几何报告
  modal <versionId> --line N          查看某行前后模态状态
  length <versionId>                  查询总长度（mm）
  export <versionId> [--out file]     导出段列表（JSON 或 --format csv）
  list                                列出全部程序（历史）
  versions <programId>                列出程序的版本（新旧比较）
  demo                                运行内置演示（四分之一圆 / 四分之三圆）
`);
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function printDiagnostics(diags: { line: number; word: string | null; code: string; message: string }[]): void {
  for (const d of diags) {
    console.log(`  [${d.code}] 行 ${d.line}${d.word ? ` 字 "${d.word}"` : ""}: ${d.message}`);
  }
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const dbPath = argValue(args, "--db") ?? DEFAULT_DB;

  switch (cmd) {
    case "serve": {
      const port = Number(argValue(args, "--port") ?? "0");
      const { port: actual } = await startServer(port, dbPath);
      console.log(`G-code 解释服务已启动: http://127.0.0.1:${actual} (数据库: ${dbPath})`);
      return; // 保持进程运行
    }
    case "import": {
      const file = args[0];
      if (!file) return usage();
      const source = fs.readFileSync(file, "utf-8");
      const name = argValue(args, "--name") ?? path.basename(file);
      const store = new Store({ dbPath });
      const r = store.createProgram(name, source);
      console.log(`程序 ${r.programId} 版本 ${r.versionNo} (versionId=${r.versionId}) 分析: ${r.result.ok ? "成功" : "失败"}`);
      if (r.result.ok) {
        console.log(`段数 ${r.result.segments.length}，总长度 ${r.result.totalLength.toFixed(6)} mm`);
      } else {
        printDiagnostics(r.result.diagnostics);
      }
      store.close();
      return;
    }
    case "validate": {
      const file = args[0];
      if (!file) return usage();
      const source = fs.readFileSync(file, "utf-8");
      const result = interpret(source);
      console.log(result.ok ? `校验通过：${result.segments.length} 段，总长度 ${result.totalLength.toFixed(6)} mm` : "校验失败：");
      if (!result.ok) printDiagnostics(result.diagnostics);
      process.exitCode = result.ok ? 0 : 1;
      return;
    }
    case "report": {
      const versionId = Number(args[0]);
      const store = new Store({ dbPath });
      const v = store.getVersion(versionId);
      if (!v) {
        console.error(`版本 ${versionId} 不存在`);
        process.exitCode = 1;
        return;
      }
      const a = store.latestAnalysis(versionId);
      console.log(`版本 ${v.id}（程序 ${v.program_id} 第 ${v.version_no} 版，容差版本 ${v.tolerance_version}）`);
      console.log(`约定: ${v.conventions}`);
      console.log(`原始来源:\n${v.source}`);
      if (!a) return;
      console.log(`分析状态: ${a.status}`);
      const diags = JSON.parse(a.diagnostics);
      if (diags.length) printDiagnostics(diags);
      if (a.status === "ok") {
        const { rows } = store.getSegments(a.id, 0, store.limits.maxPageSize);
        for (const s of rows as Record<string, unknown>[]) {
          const arc = s.type === "arc"
            ? ` 圆心(${s.cx},${s.cy}) ${s.direction} 扫角 ${(Number(s.sweep) * 180 / Math.PI).toFixed(3)}°`
            : "";
          console.log(`  #${s.seq} 行${s.line} ${s.type} (${s.sx},${s.sy}) -> (${s.ex},${s.ey})${arc} 长度 ${Number(s.length).toFixed(6)}`);
        }
        console.log(`总长度: ${a.total_length} mm`);
      }
      store.close();
      return;
    }
    case "modal": {
      const versionId = Number(args[0]);
      const line = Number(argValue(args, "--line"));
      const store = new Store({ dbPath });
      const a = store.latestAnalysis(versionId);
      if (!a || a.status !== "ok") {
        console.error("该版本分析未成功，无模态记录");
        process.exitCode = 1;
        return;
      }
      const row = store.getModalByLine(a.id, line) as
        | { source: string; before_state: string; after_state: string; segment_seq: number | null }
        | undefined;
      if (!row) {
        console.error(`第 ${line} 行无模态记录`);
        process.exitCode = 1;
        return;
      }
      console.log(`行 ${line}: ${row.source}`);
      console.log(`  前: ${row.before_state}`);
      console.log(`  后: ${row.after_state}`);
      console.log(`  生成段: ${row.segment_seq ?? "无"}`);
      store.close();
      return;
    }
    case "length": {
      const store = new Store({ dbPath });
      const a = store.latestAnalysis(Number(args[0]));
      if (!a || a.status !== "ok") {
        console.error("该版本分析未成功，无总长度");
        process.exitCode = 1;
        return;
      }
      console.log(`${a.total_length} mm`);
      store.close();
      return;
    }
    case "export": {
      const store = new Store({ dbPath });
      const a = store.latestAnalysis(Number(args[0]));
      if (!a || a.status !== "ok") {
        console.error("该版本分析未成功，无段可导出");
        process.exitCode = 1;
        return;
      }
      const { rows } = store.getSegments(a.id, 0, store.limits.maxPageSize);
      const format = argValue(args, "--format") ?? "json";
      const out = argValue(args, "--out");
      const content =
        format === "csv"
          ? ["seq,line,type,sx,sy,ex,ey,cx,cy,direction,sweep,length",
              ...(rows as Record<string, unknown>[]).map((r) =>
                [r.seq, r.line, r.type, r.sx, r.sy, r.ex, r.ey, r.cx ?? "", r.cy ?? "", r.direction ?? "", r.sweep ?? "", r.length].join(",")
              ),
            ].join("\n")
          : JSON.stringify(rows, null, 2);
      if (out) {
        fs.writeFileSync(out, content, "utf-8");
        console.log(`已导出 ${(rows as unknown[]).length} 段到 ${out}`);
      } else {
        console.log(content);
      }
      store.close();
      return;
    }
    case "list": {
      const store = new Store({ dbPath });
      console.log(JSON.stringify(store.listPrograms(), null, 2));
      store.close();
      return;
    }
    case "versions": {
      const store = new Store({ dbPath });
      console.log(JSON.stringify(store.listVersions(Number(args[0])), null, 2));
      store.close();
      return;
    }
    case "demo": {
      runDemo(dbPath);
      return;
    }
    default:
      usage();
  }
}

function runDemo(dbPath: string): void {
  const store = new Store({ dbPath });
  const show = (title: string, source: string) => {
    const r = interpret(source);
    console.log(`\n== ${title} ==`);
    console.log(source);
    if (!r.ok) {
      printDiagnostics(r.diagnostics);
      return;
    }
    for (const s of r.segments) {
      if (s.type === "arc") {
        console.log(
          `  圆弧 行${s.line}: (${s.start.x},${s.start.y}) -> (${s.end.x},${s.end.y}) 圆心(${s.center!.x},${s.center!.y}) ${s.direction} 扫角 ${(s.sweep! * 180 / Math.PI).toFixed(1)}° 长度 ${s.length.toFixed(6)}`
        );
      } else {
        console.log(`  直线 行${s.line}: (${s.start.x},${s.start.y}) -> (${s.end.x},${s.end.y}) 长度 ${s.length.toFixed(6)}`);
      }
    }
    console.log(`  总长度: ${r.totalLength.toFixed(6)} mm`);
  };

  const ccw = "G1 X1 Y0\nG3 X0 Y1 I-1 J0\n";
  const cw = "G1 X1 Y0\nG2 X0 Y1 I-1 J0\n";
  show("演示 1：G3 逆时针 → 四分之一圆（弧长 ≈ π/2 ≈ 1.570796）", ccw);
  show("演示 2：G2 顺时针 → 四分之三圆（弧长 ≈ 3π/2 ≈ 4.712389）", cw);

  // 版本比较：同一程序的两个版本
  const v1 = store.createProgram("演示程序", ccw);
  const v2 = store.addVersion(v1.programId, cw);
  console.log(`\n== 版本比较（程序 ${v1.programId}）==`);
  console.log(`  版本 ${v1.versionNo}: 总长度 ${v1.result.totalLength.toFixed(6)} mm`);
  console.log(`  版本 ${v2.versionNo}: 总长度 ${v2.result.totalLength.toFixed(6)} mm`);

  // 非法行拒绝
  const bad = "G1 X1 Y0\nG5 X2 Y2\n";
  const rb = interpret(bad);
  console.log(`\n== 非法行拒绝 ==`);
  console.log(bad);
  console.log(`  结果: ${rb.ok ? "通过（异常！）" : "已拒绝"}`);
  printDiagnostics(rb.diagnostics);
  store.close();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
