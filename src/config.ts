export const CONFIG = {
  MAX_LINES: 10000,
  MAX_ABS_VALUE: 1e6,
  PAGE_LIMIT_MAX: 500,
  PAGE_LIMIT_DEFAULT: 100,
  ABS_TOL: 1e-6,
  REL_TOL: 1e-6,
  TOLERANCE_VERSION: "1.0.0",
  DATA_DIR: "data",
  DB_FILE: "gcode.db",
} as const;

export const CONVENTIONS = {
  plane: "XY",
  unit: "mm",
  initial: { x: 0, y: 0, distanceMode: "G90", motionMode: "G0" },
} as const;
