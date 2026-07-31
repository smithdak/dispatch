import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";

import { assertSortableId, isSortableId } from "../core/identity";
import type { SessionProjection } from "../core/index";
import {
  parseCanonicalEventForRead,
  type ReadableEvent,
} from "../core/ledger";
import {
  sessionDirectory,
  type DispatchPaths,
} from "../core/paths";
import { DispatchError } from "../core/errors";

export const SESSION_META_VERSION = 1 as const;

export interface SessionMeta extends SessionProjection {
  readonly v: typeof SESSION_META_VERSION;
  readonly baseCommit: string;
}

const META_FIELDS = new Set([
  "v",
  "sid",
  "mid",
  "repositoryPath",
  "worktreePath",
  "branch",
  "baseBranch",
  "baseCommit",
  "createdAt",
  "muxTarget",
]);

function requiredString(
  value: Record<string, unknown>,
  field: string,
): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new DispatchError(
      "session.meta_invalid",
      `Session metadata field ${field} must be a non-empty string.`,
      { field },
    );
  }
  return candidate;
}

export function parseSessionMeta(value: unknown): SessionMeta {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DispatchError(
      "session.meta_invalid",
      "Session metadata must be a JSON object.",
    );
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !META_FIELDS.has(key));
  if (unknown.length > 0) {
    throw new DispatchError(
      "session.meta_invalid",
      `Unknown session metadata fields: ${unknown.join(", ")}.`,
    );
  }
  if (record.v !== SESSION_META_VERSION) {
    throw new DispatchError(
      "session.meta_invalid",
      `Unsupported session metadata version: ${String(record.v)}.`,
    );
  }

  const sid = requiredString(record, "sid");
  assertSortableId(sid, "sid");
  const createdAt = requiredString(record, "createdAt");
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt) ||
    new Date(createdAt).toISOString() !== createdAt
  ) {
    throw new DispatchError(
      "session.meta_invalid",
      "Session metadata createdAt must be a canonical UTC timestamp.",
    );
  }

  const muxTarget = record.muxTarget;
  if (muxTarget !== undefined && typeof muxTarget !== "string") {
    throw new DispatchError(
      "session.meta_invalid",
      "Session metadata muxTarget must be a string when present.",
    );
  }

  return {
    v: SESSION_META_VERSION,
    sid,
    mid: requiredString(record, "mid"),
    repositoryPath: resolve(requiredString(record, "repositoryPath")),
    worktreePath: resolve(requiredString(record, "worktreePath")),
    branch: requiredString(record, "branch"),
    baseBranch: requiredString(record, "baseBranch"),
    baseCommit: requiredString(record, "baseCommit"),
    createdAt,
    ...(muxTarget ? { muxTarget } : {}),
  };
}

export function sessionMetaFromCreatedEvent(
  event: ReadableEvent,
  expectedSid = event.sid,
): SessionMeta {
  if (
    event.sid !== expectedSid ||
    event.seq !== 1 ||
    event.src !== "dsp" ||
    event.kind !== "session.created"
  ) {
    throw new DispatchError(
      "session.ledger_origin_invalid",
      `Session ${expectedSid} must begin with a dsp session.created event at sequence 1.`,
      {
        expectedSid,
        actualSid: event.sid,
        sequence: event.seq,
        source: event.src,
        kind: event.kind,
      },
    );
  }

  const data = event.data as Record<string, unknown>;
  return parseSessionMeta({
    v: SESSION_META_VERSION,
    sid: event.sid,
    mid: event.mid,
    repositoryPath: data.repositoryPath,
    worktreePath: data.worktreePath,
    branch: data.branch,
    baseBranch: data.baseBranch,
    baseCommit: data.baseCommit,
    createdAt: data.createdAt,
    ...(data.muxTarget === undefined ? {} : { muxTarget: data.muxTarget }),
  });
}

export function sessionMetaPath(paths: DispatchPaths, sid: string): string {
  assertSortableId(sid, "sid");
  return join(sessionDirectory(paths, sid), "meta.json");
}

export function sessionEventsPath(paths: DispatchPaths, sid: string): string {
  assertSortableId(sid, "sid");
  return join(sessionDirectory(paths, sid), "events.jsonl");
}

export function writeSessionMeta(
  paths: DispatchPaths,
  meta: SessionMeta,
): void {
  publishSessionMeta(paths, meta, false);
}

export function restoreSessionMeta(
  paths: DispatchPaths,
  meta: SessionMeta,
): void {
  publishSessionMeta(paths, meta, true);
}

function publishSessionMeta(
  paths: DispatchPaths,
  meta: SessionMeta,
  replace: boolean,
): void {
  const validated = parseSessionMeta(meta);
  const directory = sessionDirectory(paths, validated.sid);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "meta.json");
  if (replace) {
    try {
      const existing = parseSessionMeta(
        JSON.parse(readFileSync(path, "utf8")),
      );
      if (JSON.stringify(existing) === JSON.stringify(validated)) return;
    } catch {
      // Missing, malformed, or divergent derived metadata is replaced below
      // from the authoritative ledger origin.
    }
  }
  const temporary = join(
    directory,
    `.meta-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
  );
  let descriptor: number | undefined;
  let published = false;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(
      descriptor,
      `${JSON.stringify(validated, null, 2)}\n`,
      "utf8",
    );
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    if (replace) {
      try {
        // POSIX rename-over-existing publishes the fully synced replacement
        // atomically. Windows refuses that operation even for this closed
        // derived file, so the recoverable projection needs a fallback.
        renameSync(temporary, path);
      } catch (error) {
        if (
          process.platform !== "win32" ||
          !(error instanceof Error) ||
          !("code" in error) ||
          !["EEXIST", "EPERM"].includes(String(error.code))
        ) {
          throw error;
        }
        // The ledger remains authoritative during this non-atomic Windows
        // gap. A failed second rename leaves metadata absent, which the next
        // read deterministically reconstructs again.
        try {
          unlinkSync(path);
        } catch (unlinkError) {
          if (
            !(unlinkError instanceof Error) ||
            !("code" in unlinkError) ||
            unlinkError.code !== "ENOENT"
          ) {
            throw unlinkError;
          }
        }
        renameSync(temporary, path);
      }
    } else {
      // A same-directory hard link publishes the fully synced inode without
      // ever replacing existing immutable metadata.
      linkSync(temporary, path);
    }
    published = true;
    try {
      syncDirectory(directory);
    } catch {
      // The immutable name is already visible and cannot be rolled back
      // without risking deletion of valid state. Treat directory-fsync
      // support as a durability capability, not an operation failure.
    }
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "EEXIST" &&
      !replace
    ) {
      throw new DispatchError(
        "session.meta_exists",
        `Session metadata already exists for ${validated.sid}.`,
        { sid: validated.sid, path },
        { cause: error },
      );
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (
        !published &&
        (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "ENOENT"
        )
      ) {
        throw error;
      }
    }
  }
}

function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function readSessionMeta(
  paths: DispatchPaths,
  sid: string,
): SessionMeta {
  assertSortableId(sid, "sid");
  const path = sessionMetaPath(paths, sid);
  let projectionError: unknown;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const meta = parseSessionMeta(parsed);
    if (meta.sid !== sid) {
      throw new DispatchError(
        "session.meta_mismatch",
        `Session directory ${sid} contains metadata for ${meta.sid}.`,
        { sid, metadataSid: meta.sid, path },
      );
    }
    return meta;
  } catch (error) {
    projectionError = error;
  }

  try {
    const recovered = recoverSessionMetaFromLedger(paths, sid);
    restoreSessionMeta(paths, recovered);
    return recovered;
  } catch (recoveryError) {
    throw new DispatchError(
      "session.meta_read_failed",
      `Cannot rebuild session metadata for ${sid} from its authoritative ledger.`,
      {
        sid,
        path,
        projectionError:
          projectionError instanceof Error
            ? projectionError.message
            : String(projectionError),
      },
      { cause: recoveryError },
    );
  }
}

function recoverSessionMetaFromLedger(
  paths: DispatchPaths,
  sid: string,
): SessionMeta {
  const eventsPath = sessionEventsPath(paths, sid);
  const contents = readFileSync(eventsPath, "utf8");
  const boundary = contents.indexOf("\n");
  if (boundary < 0) {
    throw new DispatchError(
      "session.ledger_origin_uncommitted",
      `Session ${sid} has no newline-committed origin event.`,
      { sid, eventsPath },
    );
  }

  const firstLine = contents.slice(0, boundary).replace(/\r$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch (error) {
    throw new DispatchError(
      "session.ledger_origin_invalid",
      `Session ${sid} has an invalid origin record.`,
      { sid, eventsPath },
      { cause: error },
    );
  }
  return sessionMetaFromCreatedEvent(
    parseCanonicalEventForRead(parsed),
    sid,
  );
}

export function listSessionIds(paths: DispatchPaths): string[] {
  let entries;
  try {
    entries = readdirSync(paths.sessionsDir, { withFileTypes: true });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }

  return entries
    .filter((entry) => entry.isDirectory() && isSortableId(entry.name))
    .filter((entry) => hasLedgerOriginArtifact(paths, entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function hasLedgerOriginArtifact(
  paths: DispatchPaths,
  sid: string,
): boolean {
  try {
    // An empty file is indistinguishable from the pre-write window and has no
    // committed fact to recover. A non-empty torn record remains discoverable
    // so replay can report corruption rather than silently discarding bytes.
    return statSync(sessionEventsPath(paths, sid)).size > 0;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

export function readAllSessionMeta(paths: DispatchPaths): SessionMeta[] {
  return listSessionIds(paths).map((sid) => readSessionMeta(paths, sid));
}
