import { test } from "node:test";
import assert from "node:assert/strict";
import { interpret } from "../src/interpreter.js";

const closeTo = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("演示: G3 四分之一圆", () => {
  const r = interpret("G1 X1 Y0\nG3 X0 Y1 I-1 J0\n");
  assert.ok(r.ok);
  const arc = r.segments[1];
  assert.deepEqual(arc.center, { x: 0, y: 0 });
  closeTo(arc.sweep!, Math.PI / 2);
  closeTo(arc.length, Math.PI / 2);
  assert.equal(arc.direction, "CCW");
});

test("演示: G2 同起终点为四分之三圆", () => {
  const r = interpret("G1 X1 Y0\nG2 X0 Y1 I-1 J0\n");
  const arc = r.segments[1];
  closeTo(arc.sweep!, (3 * Math.PI) / 2);
  closeTo(arc.length, (3 * Math.PI) / 2);
  assert.equal(arc.direction, "CW");
});

test("绝对与增量混用", () => {
  const r = interpret("G90\nG1 X10 Y0\nG91\nX5 Y-3\nG90\nX0 Y0\n");
  assert.ok(r.ok);
  assert.deepEqual(r.segments[0].end, { x: 10, y: 0 });
  assert.deepEqual(r.segments[1].end, { x: 15, y: -3 });
  assert.deepEqual(r.segments[2].end, { x: 0, y: 0 });
});

test("坐标模式对本行先生效", () => {
  const r = interpret("G1 X10\nG91 X5\n");
  assert.deepEqual(r.segments[1].end, { x: 15, y: 0 });
});

test("运动模态继承与省略单轴", () => {
  const r = interpret("G1 X3 Y4\nX6\nY8\n");
  assert.ok(r.ok);
  assert.equal(r.segments.length, 3);
  assert.equal(r.segments[0].length, 5);
  assert.deepEqual(r.segments[1].end, { x: 6, y: 4 });
  assert.deepEqual(r.segments[2].end, { x: 6, y: 8 });
});

test("三四五三角形直线长度", () => {
  const r = interpret("G1 X3 Y4\n");
  closeTo(r.segments[0].length, 5);
});

test("整圆: 起终点相同", () => {
  const r = interpret("G1 X1 Y0\nG2 X1 Y0 I-1 J0\n");
  const arc = r.segments[1];
  closeTo(arc.sweep!, 2 * Math.PI);
  closeTo(arc.length, 2 * Math.PI);
});

test("负坐标", () => {
  const r = interpret("G1 X-2 Y-3\nG3 X-1 Y-4 I1 J0\n");
  assert.ok(r.ok);
  const arc = r.segments[1];
  assert.deepEqual(arc.center, { x: -1, y: -3 });
  closeTo(arc.sweep!, Math.PI / 2);
});

test("半径不一致拒绝", () => {
  const r = interpret("G1 X1 Y0\nG3 X0 Y2 I-1 J0\n");
  assert.equal(r.ok, false);
  assert.equal(r.diagnostics[0].code, "E_ARC_RADIUS_MISMATCH");
  assert.equal(r.diagnostics[0].line, 2);
});

test("零半径与无圆心拒绝", () => {
  assert.equal(interpret("G2 X1 Y1\n").diagnostics[0].code, "E_ARC_NO_CENTER");
  assert.equal(interpret("G2 X0 Y0 I0 J0\n").diagnostics[0].code, "E_ARC_NO_CENTER");
});

test("重复字拒绝", () => {
  const r = interpret("G1 X1 X2\n");
  assert.equal(r.diagnostics[0].code, "E_DUPLICATE_WORD");
});

test("不支持的指令与字母", () => {
  assert.equal(interpret("M3 S1000\n").diagnostics[0].code, "E_UNSUPPORTED_LETTER");
  assert.equal(interpret("G1 Z5\n").diagnostics[0].code, "E_UNSUPPORTED_LETTER");
  assert.equal(interpret("G1 F100\n").diagnostics[0].code, "E_UNSUPPORTED_LETTER");
  assert.equal(interpret("G1 X1 R2\n").diagnostics[0].code, "E_UNSUPPORTED_LETTER");
  assert.equal(interpret("G4 X1\n").diagnostics[0].code, "E_UNSUPPORTED_G");
  assert.equal(interpret("N10 G1 X1\n").diagnostics[0].code, "E_UNSUPPORTED_LETTER");
});

test("每行至多一个运动代码", () => {
  // 同一字母重复先由重复字检查拒绝
  assert.equal(interpret("G1 G2 X1\n").diagnostics[0].code, "E_DUPLICATE_WORD");
  assert.equal(interpret("G90 G91 X1\n").diagnostics[0].code, "E_DUPLICATE_WORD");
});

test("注释、大小写、空行", () => {
  const r = interpret("; 注释\ng1 x1 y0 ; 行尾注释\n\n  \nG3 X0 Y1 I-1 J0\n");
  assert.ok(r.ok);
  assert.equal(r.segments.length, 2);
});

test("单纯模式指令不生成段、不重置位置", () => {
  const r = interpret("G1 X5\nG91\nG90\nX6\n");
  assert.ok(r.ok);
  assert.equal(r.segments.length, 2);
  assert.deepEqual(r.segments[1].end, { x: 6, y: 0 });
});

test("I/J 不受 G90/G91 影响", () => {
  const a = interpret("G90\nG1 X1 Y0\nG3 X0 Y1 I-1 J0\n");
  const b = interpret("G91\nG1 X1 Y0\nG90\nG3 X0 Y1 I-1 J0\n");
  assert.deepEqual(a.segments[1].center, b.segments[1].center);
});

test("圆弧参数角采样: 半径、首尾、方向", () => {
  const r = interpret("G1 X2 Y0\nG3 X0 Y2 I-2 J0\n");
  const arc = r.segments[1];
  const center = arc.center!;
  const radius = arc.radius!;
  const sweep = arc.sweep!;
  const a0 = Math.atan2(arc.start.y - center.y, arc.start.x - center.x);
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const a = a0 + sweep * t;
    const px = center.x + radius * Math.cos(a);
    const py = center.y + radius * Math.sin(a);
    closeTo(Math.hypot(px - center.x, py - center.y), radius);
    if (t === 0) { closeTo(px, arc.start.x); closeTo(py, arc.start.y); }
    if (t === 1) { closeTo(px, arc.end.x); closeTo(py, arc.end.y); }
  }
  const mid = a0 + sweep / 2;
  assert.ok(Math.cos(mid) > 0 && Math.sin(mid) > 0);
});

test("数值有限性与行号定位", () => {
  const r = interpret("G1 X1\nG1 X1e999\n");
  assert.equal(r.diagnostics[0].code, "E_NON_FINITE");
  assert.equal(r.diagnostics[0].line, 2);
  const r2 = interpret("G1 X2000000\n");
  assert.equal(r2.diagnostics[0].code, "E_VALUE_RANGE");
});
