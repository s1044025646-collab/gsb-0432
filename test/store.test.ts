import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/store";

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gcode-")), "test.db");
}

test("导入程序、版本比较、重启后读取", () => {
  const db = tmpDb();
  const ccw = "G1 X1 Y0\nG3 X0 Y1 I-1 J0\n";
  const cw = "G1 X1 Y0\nG2 X0 Y1 I-1 J0\n";

  const s1 = new Store({ dbPath: db });
  const v1 = s1.createProgram("演示", ccw);
  assert.ok(v1.result.ok);
  assert.ok(Math.abs(v1.result.totalLength - (1 + Math.PI / 2)) < 1e-9);
  const v2 = s1.addVersion(v1.programId, cw);
  assert.equal(v2.versionNo, 2);
  assert.ok(Math.abs(v2.result.totalLength - (1 + (3 * Math.PI) / 2)) < 1e-9);
  s1.close();

  // 重启（重新打开数据库）后读取原始来源与完整几何报告
  const s2 = new Store({ dbPath: db });
  const v = s2.getVersion(v2.versionId)!;
  assert.equal(v.source, cw);
  assert.equal(v.tolerance_version, "1.0");
  const a = s2.latestAnalysis(v2.versionId)!;
  assert.equal(a.status, "ok");
  const { rows, total } = s2.getSegments(a.id, 0, 100);
  assert.equal(total, 2);
  const arc = rows[1] as unknown as { cx: number; cy: number; direction: string; sweep: number };
  assert.equal(arc.cx, 0);
  assert.equal(arc.cy, 0);
  assert.equal(arc.direction, "CW");
  assert.ok(Math.abs(arc.sweep - (3 * Math.PI) / 2) < 1e-9);
  const versions = s2.listVersions(v1.programId) as unknown[];
  assert.equal(versions.length, 2);
  s2.close();
});

test("非法程序：保存诊断但不保存段，不污染旧成功数据", () => {
  const db = tmpDb();
  const s = new Store({ dbPath: db });
  const good = s.createProgram("p", "G1 X1 Y0\n");
  assert.ok(good.result.ok);
  const bad = s.addVersion(good.programId, "G1 X1 Y0\nG5 X2\n");
  assert.ok(!bad.result.ok);
  const aBad = s.latestAnalysis(bad.versionId)!;
  assert.equal(aBad.status, "error");
  assert.equal(aBad.total_length, null);
  const { total } = s.getSegments(aBad.id, 0, 100);
  assert.equal(total, 0, "非法版本不得保存段");
  // 旧成功版本数据不受影响
  const aGood = s.latestAnalysis(good.versionId)!;
  assert.equal(aGood.status, "ok");
  assert.equal(s.getSegments(aGood.id, 0, 100).total, 1);
  s.close();
});

test("模态按行查询", () => {
  const db = tmpDb();
  const s = new Store({ dbPath: db });
  const r = s.createProgram("p", "G90\nG1 X1 Y0\nG91\nX1\n");
  const row = s.getModalByLine(r.analysisId, 4) as { before_state: string; after_state: string };
  const before = JSON.parse(row.before_state);
  const after = JSON.parse(row.after_state);
  assert.equal(before.distance, 91);
  assert.equal(after.x, 2);
  s.close();
});
