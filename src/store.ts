// SQLite 持久层：程序、版本、分析报告、段列表、逐行模态。
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  interpret,
  InterpretResult,
  Limits,
  Tolerances,
  DEFAULT_LIMITS,
  DEFAULT_TOLERANCES,
  TOLERANCE_VERSION,
} from "./gcode";

export interface StoreOptions {
  dbPath?: string;
  tolerances?: Tolerances;
  limits?: Limits;
}

export class Store {
  readonly db: DatabaseSync;
  readonly tolerances: Tolerances;
  readonly limits: Limits;

  constructor(opts: StoreOptions = {}) {
    const dbPath = opts.dbPath ?? path.join(process.cwd(), "data", "gcode.db");
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.tolerances = opts.tolerances ?? DEFAULT_TOLERANCES;
    this.limits = opts.limits ?? DEFAULT_LIMITS;
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS programs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        program_id INTEGER NOT NULL REFERENCES programs(id),
        version_no INTEGER NOT NULL,
        source TEXT NOT NULL,
        conventions TEXT NOT NULL,
        tolerance_version TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(program_id, version_no)
      );
      CREATE TABLE IF NOT EXISTS analyses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version_id INTEGER NOT NULL REFERENCES versions(id),
        status TEXT NOT NULL CHECK(status IN ('ok','error')),
        diagnostics TEXT NOT NULL,
        total_length REAL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        analysis_id INTEGER NOT NULL REFERENCES analyses(id),
        seq INTEGER NOT NULL,
        line INTEGER NOT NULL,
        source TEXT NOT NULL,
        type TEXT NOT NULL,
        sx REAL NOT NULL, sy REAL NOT NULL,
        ex REAL NOT NULL, ey REAL NOT NULL,
        cx REAL, cy REAL,
        direction TEXT,
        sweep REAL,
        length REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS modal_states (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        analysis_id INTEGER NOT NULL REFERENCES analyses(id),
        line INTEGER NOT NULL,
        source TEXT NOT NULL,
        before_state TEXT NOT NULL,
        after_state TEXT NOT NULL,
        segment_seq INTEGER
      );
    `);
  }

  private conventionsJson(): string {
    return JSON.stringify({
      plane: "XY",
      unit: "mm",
      initial: { motion: "G0", distance: "G90", x: 0, y: 0 },
      ijMeaning: "本段起点到圆心的偏移，不受 G90/G91 影响",
      tolerances: this.tolerances,
      limits: this.limits,
    });
  }

  private runAnalysis(versionId: number, source: string): { analysisId: number; result: InterpretResult } {
    const result = interpret(source, this.tolerances, this.limits);
    // 只有完全合法的程序才保存段与总长度；非法程序只保留诊断
    const status = result.ok ? "ok" : "error";
    const stmt = this.db.prepare(
      "INSERT INTO analyses (version_id, status, diagnostics, total_length) VALUES (?,?,?,?)"
    );
    const r = stmt.run(versionId, status, JSON.stringify(result.diagnostics), result.ok ? result.totalLength : null);
    const analysisId = Number(r.lastInsertRowid);
    if (result.ok) {
      const segStmt = this.db.prepare(
        `INSERT INTO segments (analysis_id, seq, line, source, type, sx, sy, ex, ey, cx, cy, direction, sweep, length)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      for (const s of result.segments) {
        segStmt.run(
          analysisId, s.seq, s.line, s.source, s.type,
          s.start.x, s.start.y, s.end.x, s.end.y,
          s.center?.x ?? null, s.center?.y ?? null,
          s.direction, s.sweep, s.length
        );
      }
      const modStmt = this.db.prepare(
        "INSERT INTO modal_states (analysis_id, line, source, before_state, after_state, segment_seq) VALUES (?,?,?,?,?,?)"
      );
      for (const t of result.traces) {
        modStmt.run(analysisId, t.line, t.source, JSON.stringify(t.before), JSON.stringify(t.after), t.segmentSeq);
      }
    }
    return { analysisId, result };
  }

  createProgram(name: string, source: string) {
    const r = this.db.prepare("INSERT INTO programs (name) VALUES (?)").run(name);
    const programId = Number(r.lastInsertRowid);
    return this.addVersion(programId, source);
  }

  addVersion(programId: number, source: string) {
    const prog = this.db.prepare("SELECT id FROM programs WHERE id = ?").get(programId);
    if (!prog) throw new Error(`程序 ${programId} 不存在`);
    const row = this.db
      .prepare("SELECT COALESCE(MAX(version_no), 0) AS v FROM versions WHERE program_id = ?")
      .get(programId) as { v: number };
    const versionNo = row.v + 1;
    const vr = this.db
      .prepare(
        "INSERT INTO versions (program_id, version_no, source, conventions, tolerance_version) VALUES (?,?,?,?,?)"
      )
      .run(programId, versionNo, source, this.conventionsJson(), TOLERANCE_VERSION);
    const versionId = Number(vr.lastInsertRowid);
    const { analysisId, result } = this.runAnalysis(versionId, source);
    return { programId, versionId, versionNo, analysisId, result };
  }

  getVersion(versionId: number) {
    return this.db.prepare("SELECT * FROM versions WHERE id = ?").get(versionId) as
      | { id: number; program_id: number; version_no: number; source: string; conventions: string; tolerance_version: string; created_at: string }
      | undefined;
  }

  latestAnalysis(versionId: number) {
    return this.db
      .prepare("SELECT * FROM analyses WHERE version_id = ? ORDER BY id DESC LIMIT 1")
      .get(versionId) as
      | { id: number; version_id: number; status: string; diagnostics: string; total_length: number | null; created_at: string }
      | undefined;
  }

  listPrograms() {
    return this.db
      .prepare(
        `SELECT p.id, p.name, p.created_at,
                (SELECT COUNT(*) FROM versions v WHERE v.program_id = p.id) AS version_count
         FROM programs p ORDER BY p.id`
      )
      .all();
  }

  listVersions(programId: number) {
    return this.db
      .prepare(
        `SELECT v.id, v.version_no, v.tolerance_version, v.created_at, a.status, a.total_length
         FROM versions v LEFT JOIN analyses a ON a.version_id = v.id
         WHERE v.program_id = ? ORDER BY v.version_no`
      )
      .all(programId);
  }

  getSegments(analysisId: number, offset: number, limit: number) {
    const rows = this.db
      .prepare("SELECT * FROM segments WHERE analysis_id = ? ORDER BY seq LIMIT ? OFFSET ?")
      .all(analysisId, limit, offset);
    const total = (this.db
      .prepare("SELECT COUNT(*) AS c FROM segments WHERE analysis_id = ?")
      .get(analysisId) as { c: number }).c;
    return { rows, total };
  }

  getModalByLine(analysisId: number, line: number) {
    return this.db
      .prepare("SELECT * FROM modal_states WHERE analysis_id = ? AND line = ?")
      .get(analysisId, line);
  }

  close(): void {
    this.db.close();
  }
}
