// 受限 G-code 平面解释核心：词法解析 + 模态状态机 + 几何还原。
// 仅支持 XY 平面毫米坐标：G0/G1/G2/G3、G90/G91，字 X/Y/I/J。

export const TOLERANCE_VERSION = "1.0";

export interface Tolerances {
  abs: number; // 半径一致性的绝对容差（毫米）
  rel: number; // 半径一致性的相对容差（相对平均半径）
}

export const DEFAULT_TOLERANCES: Tolerances = { abs: 1e-6, rel: 1e-6 };

export interface Limits {
  maxLines: number;      // 程序最大行数
  maxAbsValue: number;   // 数值绝对值上限（毫米）
  maxPageSize: number;   // 输出分页上限
}

export const DEFAULT_LIMITS: Limits = {
  maxLines: 10000,
  maxAbsValue: 1e6,
  maxPageSize: 500,
};

export type ErrorCode =
  | "LINE_LIMIT"
  | "PARSE_SYNTAX"
  | "EMPTY_WORD"
  | "DUPLICATE_WORD"
  | "UNSUPPORTED_WORD"
  | "UNSUPPORTED_G"
  | "MULTIPLE_MOTION"
  | "MULTIPLE_DISTANCE"
  | "NON_FINITE"
  | "VALUE_RANGE"
  | "ZERO_RADIUS"
  | "NO_CENTER"
  | "RADIUS_MISMATCH";

export interface Diagnostic {
  line: number;      // 1 起始行号
  word: string | null; // 出问题的字，例如 "G5"；整行错误时为 null
  code: ErrorCode;
  message: string;
}

export class GcodeError extends Error {
  constructor(public diag: Diagnostic) {
    super(diag.message);
    this.name = "GcodeError";
  }
}

export interface Point {
  x: number;
  y: number;
}

export type MotionMode = 0 | 1 | 2 | 3;
export type DistanceMode = 90 | 91;

export interface ModalState {
  motion: MotionMode;
  distance: DistanceMode;
  x: number;
  y: number;
}

export interface Segment {
  seq: number;
  line: number;
  source: string; // 原始行文本（去注释前）
  type: "line" | "arc";
  start: Point;
  end: Point;
  center: Point | null;      // 仅圆弧
  direction: "CW" | "CCW" | null; // 仅圆弧
  sweep: number | null;      // 弧度，仅圆弧
  length: number;
}

export interface LineTrace {
  line: number;
  source: string;
  before: ModalState;
  after: ModalState;
  segmentSeq: number | null; // 本行生成的段序号，无则 null
}

export interface InterpretResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  segments: Segment[];
  traces: LineTrace[];
  totalLength: number;
  toleranceVersion: string;
}

const WORD_RE = /([A-Za-z])\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)?/y;

const SUPPORTED_G = new Set([0, 1, 2, 3, 90, 91]);
const ALLOWED_LETTERS = new Set(["G", "X", "Y", "I", "J"]);

interface Word {
  letter: string;
  raw: string;
  value: number | null;
}

function fail(line: number, word: string | null, code: ErrorCode, message: string): never {
  throw new GcodeError({ line, word, code, message });
}

function parseLine(rawLine: string, lineNo: number, limits: Limits): Word[] {
  // 分号后为行尾注释
  const noComment = rawLine.split(";")[0];
  const words: Word[] = [];
  const seen = new Set<string>();
  let pos = 0;
  const n = noComment.length;
  while (pos < n) {
    const ch = noComment[pos];
    if (ch === " " || ch === "\t" || ch === "\r") {
      pos++;
      continue;
    }
    WORD_RE.lastIndex = pos;
    const m = WORD_RE.exec(noComment);
    if (!m || m.index !== pos) {
      fail(lineNo, null, "PARSE_SYNTAX", `无法解析的字符序列，位置 ${pos + 1}: "${noComment.slice(pos, pos + 12)}"`);
    }
    pos = WORD_RE.lastIndex;
    const letter = m[1].toUpperCase();
    if (!ALLOWED_LETTERS.has(letter)) {
      fail(lineNo, letter, "UNSUPPORTED_WORD", `不支持的字 "${letter}"（Z/R/F/M 及宏变量等均不在子集内）`);
    }
    // G 字允许出现两次（一个运动代码 + 一个坐标模式代码），由上层规则约束数量；
    // 其余字母同行重复赋值一律拒绝。
    if (seen.has(letter) && letter !== "G") {
      fail(lineNo, letter, "DUPLICATE_WORD", `同一行内字母 "${letter}" 重复赋值`);
    }
    seen.add(letter);
    if (m[2] === undefined) {
      fail(lineNo, letter, "EMPTY_WORD", `字 "${letter}" 缺少数值`);
    }
    const value = Number(m[2]);
    if (!Number.isFinite(value)) {
      fail(lineNo, letter, "NON_FINITE", `字 "${m[1]}${m[2]}" 数值非有限`);
    }
    if (Math.abs(value) > limits.maxAbsValue) {
      fail(lineNo, letter, "VALUE_RANGE", `字 "${m[1]}${m[2]}" 超出数值范围 ±${limits.maxAbsValue}`);
    }
    words.push({ letter, raw: m[1] + m[2], value });
  }
  return words;
}

function normAngle(a: number): number {
  const twoPi = Math.PI * 2;
  let r = a % twoPi;
  if (r < 0) r += twoPi;
  return r;
}

export function interpret(
  source: string,
  tolerances: Tolerances = DEFAULT_TOLERANCES,
  limits: Limits = DEFAULT_LIMITS
): InterpretResult {
  const lines = source.split(/\r?\n/);
  const diagnostics: Diagnostic[] = [];
  const segments: Segment[] = [];
  const traces: LineTrace[] = [];

  if (lines.length > limits.maxLines) {
    diagnostics.push({
      line: limits.maxLines + 1,
      word: null,
      code: "LINE_LIMIT",
      message: `程序行数 ${lines.length} 超过上限 ${limits.maxLines}`,
    });
    return { ok: false, diagnostics, segments, traces, totalLength: 0, toleranceVersion: TOLERANCE_VERSION };
  }

  // 初始约定：原点、绝对模式、G0
  const state: ModalState = { motion: 0, distance: 90, x: 0, y: 0 };

  const pushTrace = (lineNo: number, raw: string, before: ModalState, segSeq: number | null) => {
    traces.push({ line: lineNo, source: raw, before, after: { ...state }, segmentSeq: segSeq });
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const lineNo = idx + 1;
    const raw = lines[idx];
    const before: ModalState = { ...state };
    let words: Word[];
    try {
      words = parseLine(raw, lineNo, limits);
    } catch (e) {
      if (e instanceof GcodeError) {
        diagnostics.push(e.diag);
        continue; // 记录诊断并继续，定位所有非法行
      }
      throw e;
    }
    if (words.length === 0) {
      continue; // 空行 / 纯注释行：无动作，不产生 trace
    }

    let motionWord: Word | null = null;
    let distanceWord: Word | null = null;
    let xWord: Word | null = null;
    let yWord: Word | null = null;
    let iWord: Word | null = null;
    let jWord: Word | null = null;
    let lineError: Diagnostic | null = null;

    for (const w of words) {
      if (w.letter === "G") {
        const g = w.value!;
        if (!Number.isInteger(g) || !SUPPORTED_G.has(g)) {
          lineError = { line: lineNo, word: w.raw, code: "UNSUPPORTED_G", message: `不支持的 G 指令 "${w.raw}"（子集仅含 G0/G1/G2/G3/G90/G91）` };
          break;
        }
        if (g === 90 || g === 91) {
          if (distanceWord) {
            lineError = { line: lineNo, word: w.raw, code: "MULTIPLE_DISTANCE", message: "同一行出现多个坐标模式代码" };
            break;
          }
          distanceWord = w;
        } else {
          if (motionWord) {
            lineError = { line: lineNo, word: w.raw, code: "MULTIPLE_MOTION", message: "同一行出现多个运动代码" };
            break;
          }
          motionWord = w;
        }
      } else if (w.letter === "X") xWord = w;
      else if (w.letter === "Y") yWord = w;
      else if (w.letter === "I") iWord = w;
      else if (w.letter === "J") jWord = w;
    }
    if (lineError) {
      diagnostics.push(lineError);
      continue;
    }

    // 坐标模式先对本行生效
    if (distanceWord) state.distance = distanceWord.value as DistanceMode;
    if (motionWord) state.motion = motionWord.value as MotionMode;

    const hasCoords = xWord !== null || yWord !== null;
    const hasArcParams = iWord !== null || jWord !== null;

    if (!hasCoords && !hasArcParams) {
      // 单纯模式指令：不生成运动段，不重置位置
      pushTrace(lineNo, raw, before, null);
      continue;
    }

    if (hasArcParams && state.motion !== 2 && state.motion !== 3) {
      diagnostics.push({
        line: lineNo,
        word: (iWord ?? jWord)!.raw,
        code: "UNSUPPORTED_WORD",
        message: "I/J 仅在 G2/G3 圆弧运动中有意义",
      });
      continue;
    }

    if (!hasCoords && hasArcParams) {
      // 整圆：终点即起点
    }

    // 计算终点：G90 绝对 / G91 增量，省略轴保持原位
    const endX = xWord ? (state.distance === 90 ? xWord.value! : state.x + xWord.value!) : state.x;
    const endY = yWord ? (state.distance === 90 ? yWord.value! : state.y + yWord.value!) : state.y;

    const start: Point = { x: state.x, y: state.y };
    const end: Point = { x: endX, y: endY };
    const source = raw;
    let seg: Segment | null = null;

    if (state.motion === 0 || state.motion === 1) {
      const length = Math.hypot(end.x - start.x, end.y - start.y);
      seg = {
        seq: segments.length,
        line: lineNo,
        source,
        type: "line",
        start,
        end,
        center: null,
        direction: null,
        sweep: null,
        length,
      };
    } else {
      // G2 顺时针 / G3 逆时针；I/J 为起点到圆心的偏移，不受 G90/G91 影响
      const i = iWord ? iWord.value! : 0;
      const j = jWord ? jWord.value! : 0;
      if (i === 0 && j === 0) {
        diagnostics.push({ line: lineNo, word: null, code: "NO_CENTER", message: "圆弧缺少有效圆心（I、J 均为零或均省略）" });
        continue;
      }
      const center: Point = { x: start.x + i, y: start.y + j };
      const r0 = Math.hypot(start.x - center.x, start.y - center.y);
      const r1 = Math.hypot(end.x - center.x, end.y - center.y);
      if (r0 === 0) {
        diagnostics.push({ line: lineNo, word: null, code: "ZERO_RADIUS", message: "圆弧半径为零" });
        continue;
      }
      const rAvg = (r0 + r1) / 2;
      const tol = Math.max(tolerances.abs, tolerances.rel * rAvg);
      if (Math.abs(r0 - r1) > tol) {
        diagnostics.push({
          line: lineNo,
          word: null,
          code: "RADIUS_MISMATCH",
          message: `起点半径 ${r0} 与终点半径 ${r1} 不一致，超出容差 ${tol}`,
        });
        continue;
      }
      const a0 = Math.atan2(start.y - center.y, start.x - center.x);
      const a1 = Math.atan2(end.y - center.y, end.x - center.x);
      const samePoint = Math.abs(end.x - start.x) <= tol && Math.abs(end.y - start.y) <= tol;
      let sweep: number;
      if (samePoint) {
        sweep = Math.PI * 2; // 起终点相同且圆心有效：完整一周
      } else if (state.motion === 3) {
        sweep = normAngle(a1 - a0); // CCW
        if (sweep === 0) sweep = Math.PI * 2;
      } else {
        sweep = normAngle(a0 - a1); // CW
        if (sweep === 0) sweep = Math.PI * 2;
      }
      seg = {
        seq: segments.length,
        line: lineNo,
        source,
        type: "arc",
        start,
        end,
        center,
        direction: state.motion === 2 ? "CW" : "CCW",
        sweep,
        length: rAvg * sweep,
      };
    }

    segments.push(seg);
    state.x = end.x;
    state.y = end.y;
    pushTrace(lineNo, raw, before, seg.seq);
  }

  const totalLength = segments.reduce((s, seg) => s + seg.length, 0);
  return {
    ok: diagnostics.length === 0,
    diagnostics,
    segments,
    traces,
    totalLength,
    toleranceVersion: TOLERANCE_VERSION,
  };
}
