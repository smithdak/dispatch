import { mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { loadConfig, type DispatchConfig } from "../core/config";
import { DispatchError, errorMessage } from "../core/errors";
import { createSortableId } from "../core/identity";
import {
  SessionIndex,
  type IndexedSession,
  type SessionStatus,
} from "../core/index";
import {
  readLastLedgerEvent,
  withExclusiveFileLock,
  type JsonObject,
  type ReadableEvent,
} from "../core/ledger";
import {
  ensureMachineId,
  ensureStateDirectories,
  pathKey,
  resolveDispatchPaths,
  sessionDirectory,
  type DispatchPaths,
  type Environment,
} from "../core/paths";
import {
  createPlannedWorktree,
  diffWorktree,
  discoverRepository,
  mergeWorktree,
  planWorktree,
  removeWorktree,
  WorktreeError,
  type MergedWorktree,
  type RemovedWorktree,
} from "../core/worktree";
import {
  appendSessionEvent,
  readSessionHistory,
  rebuildIndex,
} from "./ledger-service";
import {
  readAllSessionMeta,
  readSessionMeta,
  listSessionIds,
  sessionEventsPath,
  writeSessionMeta,
  type SessionMeta,
} from "./session-meta";

export interface ApplicationContextOptions {
  readonly paths?: DispatchPaths;
  readonly env?: Environment;
  readonly clock?: () => Date;
}

export interface CreateSessionOptions extends ApplicationContextOptions {
  readonly name?: string;
  readonly repositoryPath?: string;
  readonly baseRef?: string;
  readonly branch?: string;
  readonly worktreePath?: string;
}

export interface SessionMutationResult<T> {
  readonly value: T;
  readonly meta: SessionMeta;
  readonly projectionWarnings: readonly string[];
}

interface ResolvedApplicationContext {
  paths: DispatchPaths;
  env: Environment;
  clock: () => Date;
}

function context(
  options: ApplicationContextOptions,
): ResolvedApplicationContext {
  return {
    paths: options.paths ?? resolveDispatchPaths(options.env),
    env: options.env ?? process.env,
    clock: options.clock ?? (() => new Date()),
  };
}

function canonicalNow(clock: () => Date): string {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("Application clock must return a valid Date.");
  }
  return value.toISOString();
}

function sessionSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  if (!slug) {
    throw new DispatchError(
      "session.name_invalid",
      "Session name must contain at least one ASCII letter or number.",
    );
  }
  return slug;
}

function warning(result: { readonly projectionError?: unknown }): string | null {
  return result.projectionError
    ? `index projection failed: ${errorMessage(result.projectionError)}`
    : null;
}

async function record(
  paths: DispatchPaths,
  config: DispatchConfig,
  meta: SessionMeta,
  index: SessionIndex | undefined,
  input: Parameters<typeof appendSessionEvent>[3],
  warnings: string[],
): Promise<void> {
  const result = await appendSessionEvent(paths, config, meta, input, index);
  const message = warning(result);
  if (message) warnings.push(message);
}

function openOptionalProjection(
  paths: DispatchPaths,
  meta: SessionMeta,
  warnings: string[],
): SessionIndex | undefined {
  let index: SessionIndex | undefined;
  try {
    index = new SessionIndex(paths.indexPath);
    index.upsertSession(meta);
    return index;
  } catch (error) {
    try {
      index?.close();
    } catch {
      // Preserve the initialization/update failure that disabled projection.
    }
    warnings.push(`index projection failed: ${errorMessage(error)}`);
    return undefined;
  }
}

function closeOptionalProjection(
  index: SessionIndex | undefined,
  warnings: string[],
): void {
  try {
    index?.close();
  } catch (error) {
    warnings.push(`index projection close failed: ${errorMessage(error)}`);
  }
}

async function assertWorktreePathAvailable(
  paths: DispatchPaths,
  worktreePath: string,
): Promise<void> {
  const key = pathKey(worktreePath);
  for (const existing of readAllSessionMeta(paths)) {
    if (pathKey(existing.worktreePath) !== key) continue;
    const history = await readSessionHistory(paths, existing.sid);
    if (history.some((event) => event.kind === "worktree.removed")) {
      continue;
    }
    throw new DispatchError(
      "session.worktree_path_in_use",
      `Worktree path is already owned by session ${existing.sid}: ${worktreePath}`,
      { sid: existing.sid, worktreePath },
    );
  }
}

export async function createSession(
  options: CreateSessionOptions = {},
): Promise<SessionMutationResult<SessionMeta>> {
  const app = context(options);
  ensureStateDirectories(app.paths);

  const repository = await discoverRepository(
    resolve(options.repositoryPath ?? process.cwd()),
  );
  const config = loadConfig(app.paths, repository.topLevel, app.env);
  const sid = createSortableId();
  const name = sessionSlug(options.name ?? "session");
  const branch =
    options.branch ?? `${config.worktrees.branchPrefix}${name}-${sid}`;
  const worktreePath = resolve(
    options.worktreePath ??
      join(
        config.worktrees.root,
        basename(repository.topLevel),
        `${name}-${sid}`,
      ),
  );
  await assertWorktreePathAvailable(app.paths, worktreePath);
  mkdirSync(dirname(worktreePath), { recursive: true });

  const planned = await planWorktree({
    repositoryPath: repository.topLevel,
    worktreePath,
    branch,
    baseRef: options.baseRef ?? repository.branch,
  });
  const meta: SessionMeta = {
    v: 1,
    sid,
    mid: ensureMachineId(app.paths),
    repositoryPath: planned.repositoryPath,
    worktreePath: planned.worktreePath,
    branch: planned.branch,
    baseBranch: planned.baseBranch,
    baseCommit: planned.baseCommit,
    createdAt: canonicalNow(app.clock),
  };

  const warnings: string[] = [];
  const sessionPath = sessionDirectory(app.paths, sid);
  mkdirSync(sessionPath, { recursive: true, mode: 0o700 });

  try {
    const origin = await appendSessionEvent(
      app.paths,
      config,
      meta,
      {
        src: "dsp",
        kind: "session.created",
        data: {
          repositoryPath: meta.repositoryPath,
          worktreePath: meta.worktreePath,
          branch: meta.branch,
          baseBranch: meta.baseBranch,
          baseCommit: meta.baseCommit,
          createdAt: meta.createdAt,
          ...(meta.muxTarget === undefined
            ? {}
            : { muxTarget: meta.muxTarget }),
        },
      },
    );
    const message = warning(origin);
    if (message) warnings.push(message);
  } catch (error) {
    let originCommitted = false;
    try {
      const history = await readSessionHistory(app.paths, sid);
      originCommitted =
        history[0]?.kind === "session.created" &&
        history[0]?.seq === 1;
    } catch {
      // The rollback below is allowed only when no valid authoritative origin
      // can be observed.
    }

    if (originCommitted) {
      warnings.push(
        `session origin committed despite append completion error: ${errorMessage(error)}`,
      );
    } else {
      rmSync(sessionPath, { recursive: true, force: true });
      throw error;
    }
  }

  try {
    writeSessionMeta(app.paths, meta);
  } catch (error) {
    try {
      readSessionMeta(app.paths, sid);
      warnings.push(
        `metadata projection was recovered from the ledger: ${errorMessage(error)}`,
      );
    } catch (recoveryError) {
      throw new DispatchError(
        "session.create_metadata_failed",
        `Session ${sid} is durable, but its metadata projection could not be materialized.`,
        {
          sid,
          worktreePath: planned.worktreePath,
          recoveryError: errorMessage(recoveryError),
        },
        { cause: error },
      );
    }
  }

  try {
    await createPlannedWorktree(planned);
  } catch (error) {
    try {
      await appendSessionEvent(
        app.paths,
        config,
        meta,
        {
          src: "dsp",
          kind: "session.closed",
          data: {
            reason: "worktree-create-failed",
            error:
              error instanceof WorktreeError
                ? error.code
                : "unexpected-error",
          },
        },
      );
    } catch (receiptError) {
      throw new DispatchError(
        "session.create_worktree_failed",
        `Session ${sid} recorded durable intent, but worktree creation and failure recording both failed.`,
        {
          sid,
          worktreePath: planned.worktreePath,
          receiptError: errorMessage(receiptError),
        },
        { cause: error },
      );
    }
    throw error;
  }

  let index: SessionIndex | undefined;
  try {
    index = new SessionIndex(app.paths.indexPath);
    index.upsertSession(meta);
  } catch (error) {
    warnings.push(`index initialization failed: ${errorMessage(error)}`);
    try {
      index?.close();
    } catch {
      // The disposable projection may have failed during initialization.
    }
    index = undefined;
  }

  try {
    await record(
      app.paths,
      config,
      meta,
      index,
      {
        src: "dsp",
        kind: "worktree.created",
        data: {
          path: meta.worktreePath,
          branch: meta.branch,
          baseCommit: meta.baseCommit,
        },
      },
      warnings,
    );
  } finally {
    index?.close();
  }

  return { value: meta, meta, projectionWarnings: warnings };
}

function outcomeStats(
  history: readonly ReadableEvent[],
): { totalCost: number; turnCount: number } {
  let totalCost = 0;
  let turnCount = 0;
  for (const event of history) {
    if (event.kind === "turn.completed") turnCount += 1;
    if (event.kind !== "usage.recorded") continue;
    const cost =
      typeof event.data.totalCost === "number"
        ? event.data.totalCost
        : typeof event.data.cost === "number"
          ? event.data.cost
          : 0;
    if (Number.isFinite(cost)) totalCost += cost;
  }
  return { totalCost, turnCount };
}

function hasOutcome(history: readonly ReadableEvent[]): boolean {
  return history.some((event) => event.kind === "outcome.recorded");
}

export async function mergeSession(
  sid: string,
  options: ApplicationContextOptions = {},
): Promise<SessionMutationResult<MergedWorktree>> {
  const app = context(options);
  const meta = readSessionMeta(app.paths, sid);
  const config = loadConfig(app.paths, meta.repositoryPath, app.env);
  return withExclusiveFileLock(
    `${sessionEventsPath(app.paths, sid)}.lifecycle`,
    () => mergeSessionLocked(app, meta, config),
    { timeoutMs: config.ledger.lockTimeoutMs },
  );
}

async function mergeSessionLocked(
  app: ResolvedApplicationContext,
  meta: SessionMeta,
  config: DispatchConfig,
): Promise<SessionMutationResult<MergedWorktree>> {
  const history = await readSessionHistory(app.paths, meta.sid);
  const outcomeRecorded = hasOutcome(history);
  const sessionClosed = history.some(
    (event) => event.kind === "session.closed",
  );
  if (outcomeRecorded && sessionClosed) {
    throw new DispatchError(
      "session.already_completed",
      `Session ${meta.sid} already has a recorded outcome.`,
      { sid: meta.sid },
    );
  }
  const merged = await mergeWorktree({
    repositoryPath: meta.repositoryPath,
    worktreePath: meta.worktreePath,
    sessionBranch: meta.branch,
    baseBranch: meta.baseBranch,
  });
  const diffstat = outcomeRecorded
    ? null
    : await diffWorktree({
        repositoryPath: meta.repositoryPath,
        fromCommit: meta.baseCommit,
        toCommit: merged.sessionHeadCommit,
      });
  const stats = outcomeStats(history);
  const warnings: string[] = [];
  const index = openOptionalProjection(app.paths, meta, warnings);
  try {
    if (!history.some((event) => event.kind === "git.merged")) {
      await record(
        app.paths,
        config,
        meta,
        index,
        {
          src: "dsp",
          kind: "git.merged",
          data: {
            branch: meta.branch,
            baseBranch: meta.baseBranch,
            previousHead: merged.previousHead,
            sessionHeadCommit: merged.sessionHeadCommit,
            headCommit: merged.headCommit,
            alreadyUpToDate: merged.alreadyUpToDate,
          },
        },
        warnings,
      );
    }
    if (!outcomeRecorded && diffstat) {
      await record(
        app.paths,
        config,
        meta,
        index,
        {
          src: "dsp",
          kind: "outcome.recorded",
          data: {
            disposition: "merged",
            diffstat: {
              files: diffstat.files,
              insertions: diffstat.insertions,
              deletions: diffstat.deletions,
              binaryFiles: diffstat.binaryFiles,
            },
            wallDurationMs: Math.max(
              0,
              Date.parse(canonicalNow(app.clock)) - Date.parse(meta.createdAt),
            ),
            totalCost: stats.totalCost,
            turnCount: stats.turnCount,
          },
        },
        warnings,
      );
    }
    if (!sessionClosed) {
      await record(
        app.paths,
        config,
        meta,
        index,
        {
          src: "dsp",
          kind: "session.closed",
          data: { reason: "merged" },
        },
        warnings,
      );
    }
  } finally {
    closeOptionalProjection(index, warnings);
  }

  return { value: merged, meta, projectionWarnings: warnings };
}

export async function removeSession(
  sid: string,
  force: boolean,
  options: ApplicationContextOptions = {},
): Promise<SessionMutationResult<RemovedWorktree>> {
  const app = context(options);
  const meta = readSessionMeta(app.paths, sid);
  const config = loadConfig(app.paths, meta.repositoryPath, app.env);
  return withExclusiveFileLock(
    `${sessionEventsPath(app.paths, sid)}.lifecycle`,
    () => removeSessionLocked(app, meta, config, force),
    { timeoutMs: config.ledger.lockTimeoutMs },
  );
}

async function removeSessionLocked(
  app: ResolvedApplicationContext,
  meta: SessionMeta,
  config: DispatchConfig,
  force: boolean,
): Promise<SessionMutationResult<RemovedWorktree>> {
  const history = await readSessionHistory(app.paths, meta.sid);
  let removed: RemovedWorktree;
  const removalRecorded = history.some(
    (event) => event.kind === "worktree.removed",
  );
  if (removalRecorded) {
    // The path may now belong to a later session generation. A completed old
    // removal is idempotent by ledger identity, never by the path's current
    // occupancy.
    removed = {
      repositoryPath: meta.repositoryPath,
      worktreePath: meta.worktreePath,
      forced: force,
      wasDirty: false,
      alreadyAbsent: true,
    };
  } else {
    try {
      removed = await removeWorktree({
        repositoryPath: meta.repositoryPath,
        worktreePath: meta.worktreePath,
        expectedBranch: meta.branch,
        force,
      });
    } catch (error) {
      if (
        !(error instanceof WorktreeError) ||
        error.code !== "WORKTREE_NOT_FOUND"
      ) {
        throw error;
      }
      // A previous remove may have completed its external effect before the
      // process could append the receipt. Treat absence as an idempotent retry
      // and conservatively surface possible loss when the original operation
      // was forced.
      removed = {
        repositoryPath: meta.repositoryPath,
        worktreePath: meta.worktreePath,
        forced: force,
        wasDirty: force,
        alreadyAbsent: true,
      };
    }
  }
  const warnings: string[] = [];
  const index = openOptionalProjection(app.paths, meta, warnings);
  try {
    if (
      removed.wasDirty &&
      !history.some((event) => event.kind === "git.discarded")
    ) {
      await record(
        app.paths,
        config,
        meta,
        index,
        {
          src: "dsp",
          kind: "git.discarded",
          data: {
            branch: meta.branch,
            forced: true,
            afterOutcome: hasOutcome(history),
            inferredFromMissingWorktree: removed.alreadyAbsent,
          },
        },
        warnings,
      );
    }
    if (!removalRecorded) {
      await record(
        app.paths,
        config,
        meta,
        index,
        {
          src: "dsp",
          kind: "worktree.removed",
          data: {
            path: meta.worktreePath,
            forced: removed.forced,
            alreadyAbsent: removed.alreadyAbsent,
          },
        },
        warnings,
      );
    }
    if (!history.some((event) => event.kind === "session.closed")) {
      await record(
        app.paths,
        config,
        meta,
        index,
        {
          src: "dsp",
          kind: "session.closed",
          data: { reason: force ? "removed-force" : "removed" },
        },
        warnings,
      );
    }
  } finally {
    closeOptionalProjection(index, warnings);
  }

  return { value: removed, meta, projectionWarnings: warnings };
}

export async function listSessions(
  options: ApplicationContextOptions & {
    readonly limit?: number;
    readonly status?: SessionStatus;
    readonly repositoryPath?: string;
  } = {},
): Promise<IndexedSession[]> {
  const app = context(options);
  ensureStateDirectories(app.paths);

  let index: SessionIndex;
  try {
    index = new SessionIndex(app.paths.indexPath);
  } catch {
    await rebuildIndex(app.paths);
    index = new SessionIndex(app.paths.indexPath);
  }
  try {
    const sessionCount = listSessionIds(app.paths).length;
    const query = {
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.status !== undefined ? { status: options.status } : {}),
      ...(options.repositoryPath !== undefined
        ? { repositoryPath: options.repositoryPath }
        : {}),
    };
    let projectionCurrent = index.countSessions() === sessionCount;
    if (projectionCurrent && sessionCount > 0) {
      const projected = index.listSessions({
        limit: Math.min(sessionCount, 10_000),
      });
      projectionCurrent = projected.length === sessionCount;
      if (projectionCurrent) {
        const tails = await Promise.all(
          projected.map((session) =>
            readLastLedgerEvent(
              sessionEventsPath(app.paths, session.sid),
              session.sid,
            ),
          ),
        );
        projectionCurrent = tails.every(
          (tail, position) =>
            (tail?.seq ?? 0) === projected[position]?.lastSeq,
        );
      }
    }
    if (projectionCurrent) return index.listSessions(query);

    index.close();
    await rebuildIndex(app.paths);
    index = new SessionIndex(app.paths.indexPath);
    return index.listSessions(query);
  } finally {
    try {
      index.close();
    } catch {
      // The index may already have been closed before a rebuild.
    }
  }
}

export async function reindexSessions(
  options: ApplicationContextOptions = {},
): Promise<{ sessions: number; events: number }> {
  const app = context(options);
  ensureStateDirectories(app.paths);
  return rebuildIndex(app.paths);
}

export async function sessionLog(
  sid: string,
  options: ApplicationContextOptions & {
    readonly kind?: string;
    readonly limit?: number;
  } = {},
): Promise<readonly ReadableEvent[]> {
  const app = context(options);
  const events = await readSessionHistory(app.paths, sid);
  const filtered = options.kind
    ? events.filter((event) => event.kind === options.kind)
    : events;
  return options.limit ? filtered.slice(-options.limit) : filtered;
}

export function outcomeData(
  disposition: "merged" | "discarded" | "abandoned",
  diffstat: JsonObject,
  wallDurationMs: number,
  totalCost: number,
  turnCount: number,
): JsonObject {
  return { disposition, diffstat, wallDurationMs, totalCost, turnCount };
}
