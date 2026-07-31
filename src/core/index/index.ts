import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { Database } from "bun:sqlite";

import type { CanonicalEvent } from "../ledger";
import { pathKey } from "../paths";

export type SessionStatus =
  | "active"
  | "closed"
  | "merged"
  | "discarded"
  | "removed";

export interface SessionProjection {
  readonly sid: string;
  readonly mid: string;
  readonly repositoryPath: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly createdAt: string;
  readonly muxTarget?: string;
}

export interface IndexedSession extends SessionProjection {
  readonly status: SessionStatus;
  readonly lastSeq: number;
  readonly lastEventAt: string | null;
  readonly disposition: string | null;
  readonly diffstat: Record<string, unknown> | null;
  readonly wallDurationMs: number | null;
  readonly totalCost: number | null;
  readonly turnCount: number | null;
}

interface SessionRow {
  sid: string;
  mid: string;
  repository_path: string;
  worktree_path: string;
  branch: string;
  base_branch: string;
  created_at: string;
  mux_target: string | null;
  status: SessionStatus;
  last_seq: number;
  last_event_at: string | null;
  disposition: string | null;
  diffstat_json: string | null;
  wall_duration_ms: number | null;
  total_cost: number | null;
  turn_count: number | null;
}

function parseDiffstat(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  const parsed: unknown = JSON.parse(value);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function mapSession(row: SessionRow): IndexedSession {
  return {
    sid: row.sid,
    mid: row.mid,
    repositoryPath: row.repository_path,
    worktreePath: row.worktree_path,
    branch: row.branch,
    baseBranch: row.base_branch,
    createdAt: row.created_at,
    ...(row.mux_target ? { muxTarget: row.mux_target } : {}),
    status: row.status,
    lastSeq: row.last_seq,
    lastEventAt: row.last_event_at,
    disposition: row.disposition,
    diffstat: parseDiffstat(row.diffstat_json),
    wallDurationMs: row.wall_duration_ms,
    totalCost: row.total_cost,
    turnCount: row.turn_count,
  };
}

function eventStatus(kind: CanonicalEvent["kind"]): SessionStatus | undefined {
  switch (kind) {
    case "git.merged":
      return "merged";
    case "git.discarded":
      return "discarded";
    case "worktree.removed":
      return "removed";
    case "session.closed":
      return "closed";
    default:
      return undefined;
  }
}

function numeric(
  value: unknown,
  options: { integer?: boolean } = {},
): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (options.integer && !Number.isSafeInteger(value)) return null;
  return value;
}

export class SessionIndex {
  readonly path: string;
  readonly #database: Database;

  constructor(path: string) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.#database = new Database(this.path, { create: true, strict: true });
    try {
      this.#database.exec("PRAGMA busy_timeout = 2500;");
      // Bun 1.3.6 retains WAL sidecar handles after Database.close() on Windows.
      // DELETE mode is qualified on Windows with Bun 1.3.6 and 1.3.14 until
      // pinned-runtime WAL close/reindex semantics are proven reliable.
      this.#database.exec(
        `PRAGMA journal_mode = ${process.platform === "win32" ? "DELETE" : "WAL"};`,
      );
      this.#database.exec("PRAGMA synchronous = NORMAL;");

    // A pre-release Stage 0 snapshot made worktree_key globally UNIQUE,
    // preventing a removed path from ever being reused. The index is
    // disposable, so discard that obsolete projection rather than carrying a
    // schema migration for derived data.
    const existingSessions = this.#database
      .query<{ sql: string | null }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
      )
      .get();
    if (existingSessions?.sql?.includes("worktree_key TEXT NOT NULL UNIQUE")) {
      this.#database.exec("DROP TABLE IF EXISTS events;");
      this.#database.exec("DROP TABLE IF EXISTS sessions;");
    }

    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        mid TEXT NOT NULL,
        repository_path TEXT NOT NULL,
        repository_key TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        worktree_key TEXT NOT NULL,
        branch TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        created_at TEXT NOT NULL,
        mux_target TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        last_seq INTEGER NOT NULL DEFAULT 0,
        last_event_at TEXT,
        disposition TEXT,
        diffstat_json TEXT,
        wall_duration_ms INTEGER,
        total_cost REAL,
        turn_count INTEGER
      );

      CREATE INDEX IF NOT EXISTS sessions_created_at_idx
        ON sessions(created_at DESC);
      CREATE INDEX IF NOT EXISTS sessions_repository_key_idx
        ON sessions(repository_key, created_at DESC);
      CREATE INDEX IF NOT EXISTS sessions_worktree_key_idx
        ON sessions(worktree_key, created_at DESC);

      CREATE TABLE IF NOT EXISTS events (
        sid TEXT NOT NULL,
        seq INTEGER NOT NULL,
        id TEXT NOT NULL UNIQUE,
        ts TEXT NOT NULL,
        src TEXT NOT NULL,
        kind TEXT NOT NULL,
        data_json TEXT NOT NULL,
        ext_json TEXT,
        PRIMARY KEY (sid, seq),
        FOREIGN KEY (sid) REFERENCES sessions(sid) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS events_kind_ts_idx
        ON events(kind, ts DESC);
    `);
      this.#database.exec("PRAGMA foreign_keys = ON;");
    } catch (error) {
      try {
        this.#database.close(true);
      } catch {
        // Preserve the initialization error; the projection can be rebuilt.
      }
      throw error;
    }
  }

  close(): void {
    this.#database.close(true);
  }

  checkpoint(): void {
    if (process.platform !== "win32") {
      this.#database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    }
  }

  #run(sql: string, ...values: Array<string | number | null>): void {
    const statement = this.#database.prepare(sql);
    try {
      statement.run(...values);
    } finally {
      statement.finalize();
    }
  }

  #get<T>(
    sql: string,
    ...values: Array<string | number | null>
  ): T | null {
    const statement = this.#database.prepare(sql);
    try {
      return (statement.get(...values) as T | null) ?? null;
    } finally {
      statement.finalize();
    }
  }

  #all<T>(
    sql: string,
    ...values: Array<string | number | null>
  ): T[] {
    const statement = this.#database.prepare(sql);
    try {
      return statement.all(...values) as T[];
    } finally {
      statement.finalize();
    }
  }

  #withTransaction<T>(operation: () => T): T {
    const ownsTransaction = !this.#database.inTransaction;
    if (ownsTransaction) this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const result = operation();
      if (ownsTransaction) this.#database.exec("COMMIT;");
      return result;
    } catch (error) {
      if (ownsTransaction && this.#database.inTransaction) {
        this.#database.exec("ROLLBACK;");
      }
      throw error;
    }
  }

  upsertSession(session: SessionProjection): void {
    this.#run(
      `
        INSERT INTO sessions (
          sid, mid, repository_path, repository_key, worktree_path,
          worktree_key, branch, base_branch, created_at, mux_target
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET
          mid = excluded.mid,
          repository_path = excluded.repository_path,
          repository_key = excluded.repository_key,
          worktree_path = excluded.worktree_path,
          worktree_key = excluded.worktree_key,
          branch = excluded.branch,
          base_branch = excluded.base_branch,
          created_at = excluded.created_at,
          mux_target = excluded.mux_target
      `,
      session.sid,
      session.mid,
      resolve(session.repositoryPath),
      pathKey(session.repositoryPath),
      resolve(session.worktreePath),
      pathKey(session.worktreePath),
      session.branch,
      session.baseBranch,
      session.createdAt,
      session.muxTarget ?? null,
    );
  }

  projectEvent(event: CanonicalEvent): void {
    this.#withTransaction(() => this.#projectEvent(event));
  }

  #projectEvent(event: CanonicalEvent): void {
    this.#run(
      `
        INSERT INTO events (
          sid, seq, id, ts, src, kind, data_json, ext_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      event.sid,
      event.seq,
      event.id,
      event.ts,
      event.src,
      event.kind,
      JSON.stringify(event.data),
      event.ext ? JSON.stringify(event.ext) : null,
    );

    const status = eventStatus(event.kind);
    this.#run(
      `
        UPDATE sessions
        SET last_seq = MAX(last_seq, ?),
            last_event_at = CASE
              WHEN last_event_at IS NULL OR last_event_at < ? THEN ?
              ELSE last_event_at
            END,
            status = CASE
              WHEN ? = 'closed' AND status <> 'active' THEN status
              ELSE COALESCE(?, status)
            END
        WHERE sid = ?
      `,
      event.seq,
      event.ts,
      event.ts,
      status ?? null,
      status ?? null,
      event.sid,
    );

    if (event.kind === "outcome.recorded") {
      const data = event.data as Record<string, unknown>;
      const disposition =
        typeof data.disposition === "string" ? data.disposition : null;
      const diffstat =
        typeof data.diffstat === "object" &&
        data.diffstat !== null &&
        !Array.isArray(data.diffstat)
          ? JSON.stringify(data.diffstat)
          : null;
      this.#run(
        `
          UPDATE sessions
          SET disposition = ?,
              diffstat_json = ?,
              wall_duration_ms = ?,
              total_cost = ?,
              turn_count = ?
          WHERE sid = ?
        `,
        disposition,
        diffstat,
        numeric(data.wallDurationMs, { integer: true }),
        numeric(data.totalCost),
        numeric(data.turnCount, { integer: true }),
        event.sid,
      );
    }
  }

  getSession(sid: string): IndexedSession | null {
    const row = this.#get<SessionRow>(
      "SELECT * FROM sessions WHERE sid = ?",
      sid,
    );
    return row ? mapSession(row) : null;
  }

  countSessions(): number {
    const row = this.#get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM sessions",
    );
    return row?.count ?? 0;
  }

  listSessions(options: {
    readonly limit?: number;
    readonly status?: SessionStatus;
    readonly repositoryPath?: string;
  } = {}): IndexedSession[] {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) {
      throw new RangeError("Session list limit must be between 1 and 10000.");
    }

    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (options.status) {
      clauses.push("status = ?");
      values.push(options.status);
    }
    if (options.repositoryPath) {
      clauses.push("repository_key = ?");
      values.push(pathKey(options.repositoryPath));
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.#all<SessionRow>(
      `SELECT * FROM sessions ${where} ORDER BY created_at DESC, sid DESC LIMIT ?`,
      ...values,
      limit,
    );
    return rows.map(mapSession);
  }

  resolveByPath(cwd: string): IndexedSession | null {
    let candidate = resolve(cwd);
    for (;;) {
      const row = this.#get<SessionRow>(
        `SELECT * FROM sessions
         WHERE worktree_key = ? AND status <> 'removed'
         ORDER BY created_at DESC, sid DESC
         LIMIT 1`,
        pathKey(candidate),
      );
      if (row) return mapSession(row);

      const parent = dirname(candidate);
      if (parent === candidate) return null;
      candidate = parent;
    }
  }

  reset(): void {
    this.#withTransaction(() => {
      this.#database.exec("DELETE FROM events;");
      this.#database.exec("DELETE FROM sessions;");
    });
  }

  rebuild(
    sessions: ReadonlyArray<{
      readonly session: SessionProjection;
      readonly events: readonly CanonicalEvent[];
    }>,
  ): void {
    this.#withTransaction(() => {
      this.#database.exec("DELETE FROM events;");
      this.#database.exec("DELETE FROM sessions;");
      for (const item of sessions) {
        this.upsertSession(item.session);
        for (const event of item.events) this.#projectEvent(event);
      }
    });
  }

  restoreSession(
    session: SessionProjection,
    events: readonly CanonicalEvent[],
  ): void {
    this.#withTransaction(() => {
      this.#run("DELETE FROM events WHERE sid = ?", session.sid);
      this.#run("DELETE FROM sessions WHERE sid = ?", session.sid);
      this.upsertSession(session);
      for (const event of events) this.#projectEvent(event);
    });
  }
}
