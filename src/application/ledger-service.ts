import { isAbsolute, relative } from "node:path";
import { randomBytes } from "node:crypto";
import { renameSync, rmSync } from "node:fs";

import type { DispatchConfig } from "../core/config";
import { DispatchError } from "../core/errors";
import {
  JsonlLedger,
  LedgerCorruptionError,
  replayLedger,
  type AppendEventInput,
  type CanonicalEvent,
  type ReadableEvent,
} from "../core/ledger";
import { SessionIndex } from "../core/index";
import {
  ensureMachineId,
  pathKey,
  type DispatchPaths,
} from "../core/paths";
import {
  listSessionIds,
  readAllSessionMeta,
  readSessionMeta,
  restoreSessionMeta,
  sessionEventsPath,
  sessionMetaFromCreatedEvent,
  type SessionMeta,
} from "./session-meta";

export interface AppendedEvent {
  readonly event: CanonicalEvent;
  readonly projectionError?: unknown;
}

export interface ReindexResult {
  readonly sessions: number;
  readonly events: number;
}

export function ledgerForSession(
  paths: DispatchPaths,
  config: DispatchConfig,
  meta: SessionMeta,
): JsonlLedger {
  return new JsonlLedger({
    eventsPath: sessionEventsPath(paths, meta.sid),
    sessionId: meta.sid,
    // `mid` identifies the process that produced this record, not the machine
    // that originally created the session. This preserves provenance if state
    // is moved or later federated.
    machineId: ensureMachineId(paths),
    syncWrites: config.ledger.fsync,
    lock: { timeoutMs: config.ledger.lockTimeoutMs },
  });
}

export async function appendSessionEvent(
  paths: DispatchPaths,
  config: DispatchConfig,
  meta: SessionMeta,
  input: AppendEventInput,
  index?: SessionIndex,
): Promise<AppendedEvent> {
  const event = await ledgerForSession(paths, config, meta).append(input);
  try {
    if (index) {
      const projected = index.getSession(meta.sid);
      if (!projected || projected.lastSeq !== event.seq - 1) {
        const replay = await replayLedger(
          sessionEventsPath(paths, meta.sid),
          { expectedSessionId: meta.sid },
        );
        if (replay.issues.length > 0) {
          throw new LedgerCorruptionError(
            sessionEventsPath(paths, meta.sid),
            replay.issues,
          );
        }
        index.restoreSession(meta, replay.records);
      } else {
        index.projectEvent(event);
      }
    }
    return { event };
  } catch (projectionError) {
    // The append has committed to the authoritative ledger. A derived-index
    // failure must never be reported as an append failure and trigger a
    // duplicate provider retry.
    return { event, projectionError };
  }
}

export async function readSessionHistory(
  paths: DispatchPaths,
  sid: string,
): Promise<readonly ReadableEvent[]> {
  const replay = await replayLedger(sessionEventsPath(paths, sid), {
    expectedSessionId: sid,
  });
  if (replay.issues.length > 0) {
    throw new LedgerCorruptionError(
      sessionEventsPath(paths, sid),
      replay.issues,
    );
  }
  return replay.records;
}

export async function rebuildIndex(
  paths: DispatchPaths,
): Promise<ReindexResult> {
  const sessionIds = listSessionIds(paths);
  const projections: Array<{
    session: SessionMeta;
    events: readonly CanonicalEvent[];
  }> = [];
  let eventCount = 0;

  for (const sid of sessionIds) {
    const replay = await replayLedger(sessionEventsPath(paths, sid), {
      expectedSessionId: sid,
    });
    if (replay.issues.length > 0) {
      throw new LedgerCorruptionError(
        sessionEventsPath(paths, sid),
        replay.issues,
      );
    }
    const origin = replay.records[0];
    if (!origin) {
      throw new DispatchError(
        "session.ledger_origin_missing",
        `Session ${sid} has no committed session.created event.`,
        { sid, eventsPath: sessionEventsPath(paths, sid) },
      );
    }
    const session = sessionMetaFromCreatedEvent(origin, sid);
    restoreSessionMeta(paths, session);
    eventCount += replay.records.length;
    projections.push({
      session,
      events: replay.records,
    });
  }

  const temporaryIndexPath =
    `${paths.indexPath}.rebuild-${process.pid}-${randomBytes(8).toString("hex")}`;
  const index = new SessionIndex(temporaryIndexPath);
  try {
    index.rebuild(projections);
    index.checkpoint();
  } finally {
    index.close();
  }
  try {
    try {
      renameSync(temporaryIndexPath, paths.indexPath);
    } catch (error) {
      if (
        process.platform !== "win32" ||
        !(error instanceof Error) ||
        !("code" in error) ||
        !["EEXIST", "EPERM"].includes(String(error.code))
      ) {
        throw error;
      }
      // Windows cannot always atomically replace a closed SQLite file.
      // Both files are disposable projections and the temporary database is
      // already complete, so fall back to delete-then-publish.
      rmSync(paths.indexPath, { force: true });
      renameSync(temporaryIndexPath, paths.indexPath);
    }
  } finally {
    for (const suffix of ["", "-shm", "-wal"]) {
      rmSync(`${temporaryIndexPath}${suffix}`, { force: true });
    }
  }
  return { sessions: sessionIds.length, events: eventCount };
}

function containsPath(parent: string, candidate: string): boolean {
  const delta = relative(parent, candidate);
  return delta === "" || (!delta.startsWith("..") && !isAbsolute(delta));
}

export async function resolveSessionMetaByPath(
  paths: DispatchPaths,
  cwd: string,
  existingIndex?: SessionIndex,
): Promise<SessionMeta | null> {
  const index = existingIndex ?? new SessionIndex(paths.indexPath);
  try {
    const projected = index.resolveByPath(cwd);
    if (projected) return readSessionMeta(paths, projected.sid);

    // A deleted projection is recoverable without making a hook depend on a
    // prior explicit `dsp reindex`. This scan is the cold fallback only; the
    // successful result is immediately restored to the path index.
    const normalizedCwd = pathKey(cwd);
    const fallbacks = readAllSessionMeta(paths)
      .filter((meta) => containsPath(pathKey(meta.worktreePath), normalizedCwd))
      .sort(
        (left, right) =>
          right.worktreePath.length - left.worktreePath.length ||
          right.createdAt.localeCompare(left.createdAt) ||
          right.sid.localeCompare(left.sid),
      );
    for (const fallback of fallbacks) {
      const replay = await replayLedger(
        sessionEventsPath(paths, fallback.sid),
        { expectedSessionId: fallback.sid },
      );
      if (replay.issues.length > 0) {
        throw new LedgerCorruptionError(
          sessionEventsPath(paths, fallback.sid),
          replay.issues,
        );
      }
      if (replay.records.some((event) => event.kind === "worktree.removed")) {
        continue;
      }
      index.restoreSession(fallback, replay.records);
      return fallback;
    }
    return null;
  } finally {
    if (!existingIndex) index.close();
  }
}
