import { test } from "node:test";
import assert from "node:assert/strict";
import { interpret, DEFAULT_TOLERANCES } from "../src/gcode";

const PI = Math.PI;

test("演示：G3 四分之一圆，弧长 ≈ π/2", () => {
  const r = interpret("G1 X1 Y0\nG3 X0 Y1 I-1 J0\n");
  assert.ok(r.ok);
  assert.equal(r.segments.length, 2);
  const arc = r.segments[1];
  assert.equal(arc.type, "arc");
  assert.equal(arc.direction, "CCW");
  assert.deepEqual(arc.center, { x: 0, y: 0 });
  assert.ok(Math.abs(arc.sweep! - PI / 2) < 1e-12);
  assert.ok(Math.abs(arc.length - PI / 2) < 1e-12);
});

test("演示：G2 同参数为四分之三圆，弧长 ≈ 3π/2", () => {
  const r = interpret("G1 X1 Y0\nG2 X0 Y1 I-1 J0\n");
  assert.ok(r.ok);
  const arc = r.segments[1];
  assert.equal(arc.direction, "CW");
  assert.ok(Math.abs(arc.sweep! - (3 * PI) / 2) < 1e-12);
  assert.ok(Math.abs(arc.length - (3 * PI) / 2) < 1e-12);
});

test("圆弧参数角度采样：半径、首尾、方向", () => {
  const r = interpret("G1 X1 Y0\nG3 X0 Y1 I-1 J0\n");
  const arc = r.segments[1];
  const c = arc.center!;
  const a0 = Math.atan2(arc.start.y - c.y, arc.start.x - c.x);
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const ang = a0 + arc.sweep! * t; // CCW 正方向
    const px = c.x + Math.cos(ang);
    const py = c.y + Math.sin(ang);
    assert.ok(Math.abs(Math.hypot(px - c.x, py - c.y) - 1) < 1e-9, "半径恒定");
    if (t === 0) {
      assert.ok(Math.hypot(px - arc.start.x, py - arc.start.y) < 1e-9);
    }
    if (t === 1) {
      assert.ok(Math.hypot(px - arc.end.x, py - arc.end.y) < 1e-9);
    }
  }
  // CW 方向采样
  const r2 = interpret("G1 X1 Y0\nG2 X0 Y1 I-1 J0\n");
  const arc2 = r2.segments[1];
  const mid = a0 - arc2.sweep! / 2; // CW 负方向中点在 -135°（第三象限）
  const mx = Math.cos(mid);
  const my = Math.sin(mid);
  assert.ok(mx < 0 && my < 0, "G2 走顺时针长弧");
});

test("三四五三角形直线长度", () => {
  const r = interpret("G1 X3 Y4\n");
  assert.ok(r.ok);
  assert.ok(Math.abs(r.segments[0].length - 5) < 1e-12);
});

test("绝对与增量混用", () => {
  const r = interpret("G90\nG1 X1 Y1\nG91\nG1 X2 Y-1\nG90\nG1 X0 Y0\n");
  assert.ok(r.ok);
  assert.equal(r.segments.length, 3);
  assert.deepEqual(r.segments[1].end, { x: 3, y: 0 });
  assert.deepEqual(r.segments[2].start, { x: 3, y: 0 });
  assert.deepEqual(r.segments[2].end, { x: 0, y: 0 });
});

test("运动模态继承：省略 G 字沿用上一运动模式", () => {
  const r = interpret("G1 X1 Y0\nX2 Y2\n");
  assert.ok(r.ok);
  assert.equal(r.segments.length, 2);
  assert.equal(r.segments[1].type, "line");
});

test("省略单轴保持原位", () => {
  const r = interpret("G1 X5\nY3\n");
  assert.ok(r.ok);
  assert.deepEqual(r.segments[0].end, { x: 5, y: 0 });
  assert.deepEqual(r.segments[1].end, { x: 5, y: 3 });
});

test("单独坐标模式指令不生成运动段、不重置位置", () => {
  const r = interpret("G1 X2 Y2\nG91\nG90\nX4\n");
  assert.ok(r.ok);
  assert.equal(r.segments.length, 2);
  assert.deepEqual(r.segments[1].start, { x: 2, y: 2 });
  assert.deepEqual(r.segments[1].end, { x: 4, y: 2 });
});

test("整圆：起终点相同且圆心有效，扫角 2π", () => {
  const r = interpret("G1 X1 Y0\nG2 X1 Y0 I-1 J0\n");
  assert.ok(r.ok);
  const arc = r.segments[1];
  assert.ok(Math.abs(arc.sweep! - 2 * PI) < 1e-12);
  assert.ok(Math.abs(arc.length - 2 * PI) < 1e-12);
});

test("负坐标", () => {
  const r = interpret("G1 X-3 Y-4\nG1 X-3 Y-1\n");
  assert.ok(r.ok);
  assert.ok(Math.abs(r.segments[0].length - 5) < 1e-12);
  assert.ok(Math.abs(r.segments[1].length - 3) < 1e-12);
});

test("半径不一致拒绝", () => {
  const r = interpret("G1 X1 Y0\nG3 X0 Y2 I-1 J0\n");
  assert.ok(!r.ok);
  assert.equal(r.diagnostics[0].code, "RADIUS_MISMATCH");
  assert.equal(r.diagnostics[0].line, 2);
});

test("零半径与无圆心拒绝", () => {
  const r1 = interpret("G2 X1 Y1 I0 J0\n");
  assert.equal(r1.diagnostics[0].code, "NO_CENTER");
  const r2 = interpret("G2 X1 Y1\n");
  assert.equal(r2.diagnostics[0].code, "NO_CENTER");
});

test("重复字拒绝", () => {
  const r = interpret("G1 X1 X2 Y0\n");
  assert.ok(!r.ok);
  assert.equal(r.diagnostics[0].code, "DUPLICATE_WORD");
  assert.equal(r.diagnostics[0].word, "X");
});

test("不支持的指令：Z/R/F/M/其他 G", () => {
  for (const [src, code] of [
    ["G1 Z5\n", "UNSUPPORTED_WORD"],
    ["G2 X1 Y0 R1\n", "UNSUPPORTED_WORD"],
    ["G1 X1 F100\n", "UNSUPPORTED_WORD"],
    ["M3 S1000\n", "UNSUPPORTED_WORD"],
    ["G28\n", "UNSUPPORTED_G"],
  ] as const) {
    const r = interpret(src);
    assert.ok(!r.ok, src);
    assert.equal(r.diagnostics[0].code, code, src);
  }
});

test("每行至多一个运动代码和一个坐标模式代码", () => {
  const r1 = interpret("G1 G2 X1\n");
  assert.equal(r1.diagnostics[0].code, "MULTIPLE_MOTION");
  const r2 = interpret("G90 G91 X1\n");
  assert.equal(r2.diagnostics[0].code, "MULTIPLE_DISTANCE");
});

test("坐标模式先对本行生效", () => {
  const r = interpret("G1 X1 Y0\nG91 G1 X2 Y0\n");
  assert.ok(r.ok);
  assert.deepEqual(r.segments[1].end, { x: 3, y: 0 });
});

test("大小写、空白与分号注释", () => {
  const r = interpret("  g1   x1   y0 ; 移动到 (1,0)\n; 纯注释行\n\nG3 X0 Y1 I-1 J0 ; 四分之一圆\n");
  assert.ok(r.ok);
  assert.equal(r.segments.length, 2);
});

test("错误定位到具体行与字", () => {
  const r = interpret("G1 X1 Y0\nG1 X2 Y2\nG1 X3 X4\n");
  assert.ok(!r.ok);
  assert.equal(r.diagnostics[0].line, 3);
  assert.equal(r.diagnostics[0].word, "X");
});

test("数值必须有限且在范围内", () => {
  const r = interpret("G1 X1e9\n");
  assert.ok(!r.ok);
  assert.equal(r.diagnostics[0].code, "VALUE_RANGE");
});

test("行数上限", () => {
  const src = Array(5).fill("G1 X1").join("\n");
  const r = interpret(src, DEFAULT_TOLERANCES, { maxLines: 3, maxAbsValue: 1e6, maxPageSize: 500 });
  assert.ok(!r.ok);
  assert.equal(r.diagnostics[0].code, "LINE_LIMIT");
});

test("模态 trace：按行前后状态", () => {
  const r = interpret("G90\nG1 X1 Y0\nG91\nX1\n");
  assert.ok(r.ok);
  const t = r.traces.find((t) => t.line === 4)!;
  assert.equal(t.before.distance, 91);
  assert.deepEqual([t.before.x, t.before.y], [1, 0]);
  assert.deepEqual([t.after.x, t.after.y], [2, 0]);
});
