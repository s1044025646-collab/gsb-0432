export type ErrorCode =
  | "E_PARSE"
  | "E_DUPLICATE_WORD"
  | "E_UNSUPPORTED_LETTER"
  | "E_UNSUPPORTED_G"
  | "E_MULTIPLE_MOTION"
  | "E_MULTIPLE_DISTANCE_MODE"
  | "E_NON_FINITE"
  | "E_VALUE_RANGE"
  | "E_LINE_LIMIT"
  | "E_ARC_NO_CENTER"
  | "E_ARC_ZERO_RADIUS"
  | "E_ARC_RADIUS_MISMATCH"
  | "E_NOT_FOUND"
  | "E_BAD_REQUEST"
  | "E_INTERNAL";

export interface Diagnostic {
  code: ErrorCode;
  message: string;
  line: number | null;
  word: string | null;
}

export class GCodeError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public line: number | null = null,
    public word: string | null = null
  ) {
    super(message);
  }
  toDiagnostic(): Diagnostic {
    return { code: this.code, message: this.message, line: this.line, word: this.word };
  }
}
