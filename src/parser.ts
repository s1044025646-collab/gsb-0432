import { GCodeError } from "./errors.js";
import { CONFIG } from "./config.js";

export interface Word {
  letter: string;
  value: number;
  raw: string;
}

export interface ParsedLine {
  line: number;
  raw: string;
  words: Word[];
  empty: boolean;
}

const WORD_RE = /([A-Za-z])\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/y;

const SUPPORTED_LETTERS = new Set(["G", "X", "Y", "I", "J"]);
const UNSUPPORTED_LETTERS = new Set(["Z", "R", "F", "M", "N", "S", "T", "P", "Q", "K", "L", "H", "D", "A", "B", "C", "U", "V", "W", "O", "E"]);

export function parseProgram(source: string): ParsedLine[] {
  const lines = source.split(/\r\n|\r|\n/);
  if (lines.length > CONFIG.MAX_LINES) {
    throw new GCodeError("E_LINE_LIMIT", `程序行数 ${lines.length} 超过上限 ${CONFIG.MAX_LINES}`);
  }
  return lines.map((raw, i) => parseLine(raw, i + 1));
}

export function parseLine(raw: string, lineNo: number): ParsedLine {
  // 分号后的内容为行尾注释
  const code = raw.split(";")[0];
  const words: Word[] = [];
  const seen = new Set<string>();
  let pos = 0;
  while (pos < code.length) {
    const ch = code[pos];
    if (ch === " " || ch === "\t") {
      pos++;
      continue;
    }
    WORD_RE.lastIndex = pos;
    const m = WORD_RE.exec(code);
    if (!m || m.index !== pos) {
      throw new GCodeError(
        "E_PARSE",
        `第 ${lineNo} 行存在无法解析的内容: "${code.slice(pos).trim()}"`,
        lineNo,
        null
      );
    }
    const letter = m[1].toUpperCase();
    const value = Number(m[2]);
    if (!Number.isFinite(value)) {
      throw new GCodeError("E_NON_FINITE", `第 ${lineNo} 行字 ${m[0]} 数值非有限`, lineNo, m[0]);
    }
    if (Math.abs(value) > CONFIG.MAX_ABS_VALUE) {
      throw new GCodeError(
        "E_VALUE_RANGE",
        `第 ${lineNo} 行字 ${m[0]} 超出数值范围 ±${CONFIG.MAX_ABS_VALUE}`,
        lineNo,
        m[0]
      );
    }
    if (seen.has(letter)) {
      throw new GCodeError(
        "E_DUPLICATE_WORD",
        `第 ${lineNo} 行字母 ${letter} 重复赋值`,
        lineNo,
        m[0]
      );
    }
    seen.add(letter);
    if (UNSUPPORTED_LETTERS.has(letter)) {
      throw new GCodeError(
        "E_UNSUPPORTED_LETTER",
        `第 ${lineNo} 行字母 ${letter} 不在支持的子集内（仅支持 G/X/Y/I/J）`,
        lineNo,
        m[0]
      );
    }
    if (!SUPPORTED_LETTERS.has(letter)) {
      throw new GCodeError(
        "E_UNSUPPORTED_LETTER",
        `第 ${lineNo} 行字母 ${letter} 未识别`,
        lineNo,
        m[0]
      );
    }
    words.push({ letter, value, raw: m[0] });
    pos = WORD_RE.lastIndex;
  }
  return { line: lineNo, raw, words, empty: words.length === 0 };
}
