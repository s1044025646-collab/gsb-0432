import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { CONFIG, CONVENTIONS } from "./config.js";
import { AnalysisResult, Segment } from "./interpreter.js";

export class Store {
  private db: DatabaseSync;

  constructor(dataDir: string = CONFIG.DATA_DIR) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, CONFIG.DB_FILE));
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
        source_text TEXT NOT NULL,
        conventions TEXT NOT NULL,
        tolerance_version TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(program_id, version_no)
      );
      CREATE TABLE IF NOT EXISTS reports (
        version_id INTEGER PRIMARY KEY REFERENCES versions(id),
        status TEXT NOT NULL,
        diagnostics TEXT NOT NULL,
        total_length REAL,
        analyzed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version_id INTEGER NOT NULL REFERENCES versions(id),
        idx INTEGER NOT NULL,
        line INTEGER NOT NULL,
        raw TEXT NOT NULL,
        type TEXT NOT NULL,
        motion TEXT NOT NULL,
        start_x REAL NOT NULL, start_y REAL NOT NULL,
        end_x REAL NOT NULL, end_y REAL NOT NULL,
        center_x REAL, center_y REAL,
        radius REAL, direction TEXT, sweep REAL,
        length REAL NOT NULL,
        UNIQUE(version_id, idx)
      );
    `);
  }

  close() {
    this.db.close();
  }

  createProgram(name: string, source: string): { programId: number; versionId: number } {
    const info = this.db.prepare("INSERT INTO programs(name) VALUES (?)").run(name);
    const programId = Number(info.lastInsertRowid);
    const versionId = this.addVersion(programId, source);
    return { programId, versionId };
  }

  addVersion(programId: number, source: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(version_no), 0) AS v FROM versions WHERE program_id = ?")
      .get(programId) as { v: number } | undefined;
    if (!row) throw new Error(`程序 ${programId} 不存在`);
    const exists = this.db.prepare("SELECT 1 FROM programs WHERE id = ?").get(programId);
    if (!exists) throw new Error(`程序 ${programId} 不存在`);
    const info = this.db
      .prepare(
        "INSERT INTO versions(program_id, version_no, source_text, conventions, tolerance_version) VALUES (?,?,?,?,?)"
      )
      .run(programId, row.v + 1, source, JSON.stringify(CONVENTIONS), CONFIG.TOLERANCE_VERSION);
    return Number(info.lastInsertRowid);
  }

  saveReport(versionId: number, result: AnalysisResult): void {
    // 先清除旧报告与旧段，避免混入上次结果
    this.db.prepare("DELETE FROM segments WHERE version_id = ?").run(versionId);
    this.db.prepare("DELETE FROM reports WHERE version_id = ?").run(versionId);
    const status = result.ok ? "ok" : "error";
    this.db
      .prepare(
        "INSERT INTO reports(version_id, status, diagnostics, total_length) VALUES (?,?,?,?)"
      )
      .run(versionId, status, JSON.stringify(result.diagnostics), result.ok ? result.totalLength : null);
    if (result.ok) {
      const ins = this.db.prepare(
        `INSERT INTO segments(version_id, idx, line, raw, type, motion, start_x, start_y, end_x, end_y,
          center_x, center_y, radius, direction, sweep, length)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      for (const s of result.segments) {
        ins.run(
          versionId, s.index, s.line, s.raw, s.type, s.motion,
          s.start.x, s.start.y, s.end.x, s.end.y,
          s.center?.x ?? null, s.center?.y ?? null,
          s.radius, s.direction, s.sweep, s.length
        );
      }
    }
  }

  getProgram(id: number) {
    return this.db.prepare("SELECT * FROM programs WHERE id = ?").get(id);
  }

  listPrograms() {
    return this.db.prepare("SELECT * FROM programs ORDER BY id").all();
  }

  listVersions(programId: number) {
    return this.db
      .prepare(
        `SELECT v.*, r.status AS report_status, r.total_length
         FROM versions v LEFT JOIN reports r ON r.version_id = v.id
         WHERE v.program_id = ? ORDER BY v.version_no`
      )
      .all(programId);
  }

  getVersion(versionId: number) {
    return this.db.prepare("SELECT * FROM versions WHERE id = ?").get(versionId);
  }

  getReport(versionId: number) {
    return this.db.prepare("SELECT * FROM reports WHERE version_id = ?").get(versionId);
  }

  getSegments(versionId: number, limit: number, offset: number): Segment[] {
    const rows = this.db
      .prepare("SELECT * FROM segments WHERE version_id = ? ORDER BY idx LIMIT ? OFFSET ?")
      .all(versionId, limit, offset) as any[];
    return rows.map((r) => ({
      index: r.idx,
      line: r.line,
      raw: r.raw,
      type: r.type,
      motion: r.motion,
      start: { x: r.start_x, y: r.start_y },
      end: { x: r.end_x, y: r.end_y },
      center: r.center_x === null ? null : { x: r.center_x, y: r.center_y },
      radius: r.radius,
      direction: r.direction,
      sweep: r.sweep,
      length: r.length,
    }));
  }

  countSegments(versionId: number): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS c FROM segments WHERE version_id = ?")
      .get(versionId) as { c: number };
    return r.c;
  }
}
