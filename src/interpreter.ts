import { GCodeError, Diagnostic } from "./errors.js";
import { parseProgram, ParsedLine } from "./parser.js";
import { CONFIG, CONVENTIONS } from "./config.js";

export type MotionMode = "G0" | "G1" | "G2" | "G3";
export type DistanceMode = "G90" | "G91";

export interface ModalState {
  x: number;
  y: number;
  motion: MotionMode;
  distance: DistanceMode;
}

export interface Segment {
  index: number;
  line: number;
  raw: string;
  type: "line" | "arc";
  motion: MotionMode;
  start: { x: number; y: number };
  end: { x: number; y: number };
  center: { x: number; y: number } | null;
  radius: number | null;
  direction: "CW" | "CCW" | null;
  sweep: number | null; // 弧度
  length: number;
}

export interface LineTrace {
  line: number;
  raw: string;
  before: ModalState;
  after: ModalState;
  segmentIndex: number | null;
}

export interface AnalysisResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  segments: Segment[];
  trace: LineTrace[];
  totalLength: number;
  toleranceVersion: string;
  conventions: typeof CONVENTIONS;
}

const TWO_PI = Math.PI * 2;

function initialState(): ModalState {
  return { x: 0, y: 0, motion: "G0", distance: "G90" };
}

function classifyG(value: number, line: number, raw: string): MotionMode | DistanceMode {
  switch (value) {
    case 0: return "G0";
    case 1: return "G1";
    case 2: return "G2";
    case 3: return "G3";
    case 90: return "G90";
    case 91: return "G91";
    default:
      throw new GCodeError(
        "E_UNSUPPORTED_G",
        `第 ${line} 行 G${value} 不在支持的子集内（仅支持 G0/G1/G2/G3/G90/G91）`,
        line,
        raw
      );
  }
}

export function interpret(source: string): AnalysisResult {
  const diagnostics: Diagnostic[] = [];
  const segments: Segment[] = [];
  const trace: LineTrace[] = [];
  let parsed: ParsedLine[];
  try {
    parsed = parseProgram(source);
  } catch (e) {
    if (e instanceof GCodeError) {
      return finish(false, [e.toDiagnostic()], [], [], 0);
    }
    throw e;
  }

  let state = initialState();
  for (const pl of parsed) {
    const before = { ...state };
    let segmentIndex: number | null = null;
    try {
      if (!pl.empty) {
        segmentIndex = execLine(pl, state, segments);
        state = { ...state, x: state.x, y: state.y };
      }
    } catch (e) {
      if (e instanceof GCodeError) {
        diagnostics.push(e.toDiagnostic());
        trace.push({ line: pl.line, raw: pl.raw, before, after: { ...state }, segmentIndex: null });
        // 出错即停止，诊断定位到该行
        for (const rest of parsed.slice(pl.line)) {
          trace.push({ line: rest.line, raw: rest.raw, before: { ...state }, after: { ...state }, segmentIndex: null });
        }
        return finish(false, diagnostics, segments, trace, sumLength(segments));
      }
      throw e;
    }
    trace.push({ line: pl.line, raw: pl.raw, before, after: { ...state }, segmentIndex });
  }
  return finish(true, diagnostics, segments, trace, sumLength(segments));
}

function finish(
  ok: boolean,
  diagnostics: Diagnostic[],
  segments: Segment[],
  trace: LineTrace[],
  totalLength: number
): AnalysisResult {
  return {
    ok,
    diagnostics,
    segments,
    trace,
    totalLength,
    toleranceVersion: CONFIG.TOLERANCE_VERSION,
    conventions: CONVENTIONS,
  };
}

function sumLength(segments: Segment[]): number {
  return segments.reduce((s, seg) => s + seg.length, 0);
}

// 执行一行，就地更新 state；若生成运动段则 push 并返回其索引
function execLine(pl: ParsedLine, state: ModalState, segments: Segment[]): number | null {
  let motion: MotionMode | null = null;
  let distance: DistanceMode | null = null;
  let x: number | undefined;
  let y: number | undefined;
  let i = 0;
  let j = 0;

  for (const w of pl.words) {
    if (w.letter === "G") {
      const g = classifyG(w.value, pl.line, w.raw);
      if (g === "G90" || g === "G91") {
        if (distance !== null) {
          throw new GCodeError("E_MULTIPLE_DISTANCE_MODE", `第 ${pl.line} 行含多个坐标模式代码`, pl.line, w.raw);
        }
        distance = g;
      } else {
        if (motion !== null) {
          throw new GCodeError("E_MULTIPLE_MOTION", `第 ${pl.line} 行含多个运动代码`, pl.line, w.raw);
        }
        motion = g;
      }
    } else if (w.letter === "X") x = w.value;
    else if (w.letter === "Y") y = w.value;
    else if (w.letter === "I") i = w.value;
    else if (w.letter === "J") j = w.value;
  }

  // 坐标模式先对本行生效
  if (distance !== null) state.distance = distance;
  if (motion !== null) state.motion = motion;

  const hasCoords = x !== undefined || y !== undefined;
  const hasIJ = pl.words.some((w) => w.letter === "I" || w.letter === "J");
  const activeMotion = state.motion;
  const isArc = activeMotion === "G2" || activeMotion === "G3";

  // 无坐标且无 I/J：单纯模式指令不生成运动段
  if (!hasCoords && !hasIJ) return null;
  // 非圆弧运动且仅给 I/J：无有效目标，忽略为无运动（I/J 只对圆弧有意义）
  if (!isArc && !hasCoords) return null;

  const sx = state.x;
  const sy = state.y;
  let ex: number;
  let ey: number;
  if (state.distance === "G90") {
    ex = x !== undefined ? x : sx;
    ey = y !== undefined ? y : sy;
  } else {
    ex = sx + (x ?? 0);
    ey = sy + (y ?? 0);
  }

  let seg: Segment;
  if (isArc) {
    seg = buildArc(pl, activeMotion, sx, sy, ex, ey, i, j, segments.length);
  } else {
    const length = Math.hypot(ex - sx, ey - sy);
    seg = {
      index: segments.length,
      line: pl.line,
      raw: pl.raw,
      type: "line",
      motion: activeMotion,
      start: { x: sx, y: sy },
      end: { x: ex, y: ey },
      center: null,
      radius: null,
      direction: null,
      sweep: null,
      length,
    };
  }
  segments.push(seg);
  state.x = ex;
  state.y = ey;
  return seg.index;
}

function buildArc(
  pl: ParsedLine,
  motion: "G2" | "G3",
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  i: number,
  j: number,
  index: number
): Segment {
  if (i === 0 && j === 0) {
    throw new GCodeError("E_ARC_NO_CENTER", `第 ${pl.line} 行圆弧缺少有效圆心偏移 I/J`, pl.line, null);
  }
  const cx = sx + i;
  const cy = sy + j;
  const r0 = Math.hypot(sx - cx, sy - cy);
  const r1 = Math.hypot(ex - cx, ey - cy);
  if (r0 === 0) {
    throw new GCodeError("E_ARC_ZERO_RADIUS", `第 ${pl.line} 行圆弧半径为零`, pl.line, null);
  }
  const tol = Math.max(CONFIG.ABS_TOL, CONFIG.REL_TOL * Math.max(r0, r1));
  if (Math.abs(r0 - r1) > tol) {
    throw new GCodeError(
      "E_ARC_RADIUS_MISMATCH",
      `第 ${pl.line} 行起点半径 ${r0} 与终点半径 ${r1} 不一致（容差 ${tol}）`,
      pl.line,
      null
    );
  }
  const radius = (r0 + r1) / 2;
  const a0 = Math.atan2(sy - cy, sx - cx);
  const a1 = Math.atan2(ey - cy, ex - cx);
  const samePoint = Math.hypot(ex - sx, ey - sy) <= tol;
  let sweep: number;
  if (motion === "G3") {
    // 逆时针
    sweep = (a1 - a0) % TWO_PI;
    if (sweep < 0) sweep += TWO_PI;
    if (sweep === 0 && samePoint) sweep = TWO_PI;
  } else {
    // 顺时针
    sweep = (a0 - a1) % TWO_PI;
    if (sweep < 0) sweep += TWO_PI;
    if (sweep === 0 && samePoint) sweep = TWO_PI;
  }
  return {
    index,
    line: pl.line,
    raw: pl.raw,
    type: "arc",
    motion,
    start: { x: sx, y: sy },
    end: { x: ex, y: ey },
    center: { x: cx, y: cy },
    radius,
    direction: motion === "G2" ? "CW" : "CCW",
    sweep,
    length: radius * sweep,
  };
}
