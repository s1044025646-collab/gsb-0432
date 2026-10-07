import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/db.js";
import { interpret } from "../src/interpreter.js";

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gcode-"));
  return { store: new Store(dir), dir };
}

test("导入、分析、版本与历史", () => {
  const { store } = tmpStore();
  const { programId, versionId } = store.createProgram("p1", "G1 X3 Y4\n");
  store.saveReport(versionId, interpret("G1 X3 Y4\n"));
  assert.equal(store.countSegments(versionId), 1);
  assert.equal((store.getReport(versionId) as any).total_length, 5);

  const v2 = store.addVersion(programId, "G1 X6 Y8\n");
  store.saveReport(v2, interpret("G1 X6 Y8\n"));
  const versions = store.listVersions(programId) as any[];
  assert.equal(versions.length, 2);
  assert.equal(versions[0].total_length, 5);
  assert.equal(versions[1].total_length, 10);
  store.close();
});

test("非法程序不保存段且不混入旧段", () => {
  const { store } = tmpStore();
  const { versionId } = store.createProgram("p", "G1 X1\n");
  store.saveReport(versionId, interpret("G1 X1\n"));
  assert.equal(store.countSegments(versionId), 1);
  const v2 = store.addVersion(1, "G1 X1\nM3\n");
  store.saveReport(v2, interpret("G1 X1\nM3\n"));
  assert.equal(store.countSegments(v2), 0);
  assert.equal((store.getReport(v2) as any).status, "error");
  assert.equal(store.countSegments(versionId), 1);
  store.close();
});

test("重启后读取原始来源与报告", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gcode-"));
  const s1 = new Store(dir);
  const { versionId } = s1.createProgram("p", "G1 X1 Y0\nG3 X0 Y1 I-1 J0\n");
  s1.saveReport(versionId, interpret("G1 X1 Y0\nG3 X0 Y1 I-1 J0\n"));
  s1.close();
  const s2 = new Store(dir);
  const v = s2.getVersion(versionId) as any;
  assert.equal(v.source_text, "G1 X1 Y0\nG3 X0 Y1 I-1 J0\n");
  assert.equal(v.tolerance_version, "1.0.0");
  const segs = s2.getSegments(versionId, 100, 0);
  assert.equal(segs.length, 2);
  assert.ok(Math.abs(segs[1].length - Math.PI / 2) < 1e-9);
  s2.close();
});
