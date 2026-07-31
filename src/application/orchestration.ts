import { loadConfig, type DispatchConfig } from "../core/config";
import { DispatchError, errorMessage } from "../core/errors";
import { SessionIndex } from "../core/index";
import {
  withExclusiveFileLock,
  type JsonObject,
  type ReadableEvent,
} from "../core/ledger";
import {
  ensureStateDirectories,
  pathKey,
  physicalPath,
  resolveDispatchPaths,
  type DispatchPaths,
  type Environment,
} from "../core/paths";
import {
  MUX_TARGET_VERSION,
  MuxError,
  type MuxCloseResult,
  type MuxEnsureResult,
  type MuxPort,
  type MuxStatus,
  type MuxTarget,
} from "../ports/mux";
import {
  appendSessionEvent,
  readSessionHistory,
} from "./ledger-service";
import {
  readSessionMeta,
  sessionEventsPath,
  type SessionMeta,
} from "./session-meta";

export interface TerminalSessionOptions {
  readonly paths?: DispatchPaths;
  readonly env?: Environment;
}

export type DispatchTerminalLifecycle =
  | "created"
  | "opened"
  | "closed"
  | "removed";

export type ApplicationMuxStatus =
  | MuxStatus
  | { readonly state: "not_recorded" };

export interface OpenTerminalSessionResult {
  readonly sid: string;
  readonly target: MuxTarget;
  readonly disposition: MuxEnsureResult["disposition"];
  readonly receipt:
    | "recorded"
    | "already_recorded"
    | "recovered_after_append";
  readonly muxStatus: Extract<MuxStatus, { readonly state: "running" }>;
  readonly projectionWarnings: readonly string[];
}

export interface TerminalSessionStatusResult {
  readonly sid: string;
  readonly dispatchLifecycle: DispatchTerminalLifecycle;
  readonly lastSeq: number;
  readonly target: MuxTarget | null;
  readonly muxStatus: ApplicationMuxStatus;
}

export interface CloseTerminalSessionResult {
  readonly sid: string;
  readonly target: MuxTarget | null;
  readonly muxOutcome: MuxCloseResult["outcome"] | "not_found";
  readonly alreadyClosed: boolean;
  readonly receipt:
    | "recorded"
    | "already_recorded"
    | "recovered_after_append";
  readonly projectionWarnings: readonly string[];
}

interface OrchestrationContext {
  readonly paths: DispatchPaths;
  readonly env: Environment;
}

function context(options: TerminalSessionOptions): OrchestrationContext {
  return {
    paths: options.paths ?? resolveDispatchPaths(options.env),
    env: options.env ?? process.env,
  };
}

function logicalKey(sid: string): string {
  return sid;
}

function targetData(target: MuxTarget): JsonObject {
  return {
    version: target.version,
    backend: target.backend,
    protocol: target.protocol,
    workspaceId: target.workspaceId,
    tabId: target.tabId,
    paneId: target.paneId,
    terminalId: target.terminalId,
    canonicalCwd: target.canonicalCwd,
  };
}

function requiredString(
  value: Record<string, unknown>,
  field: keyof MuxTarget,
): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new DispatchError(
      "session.mux_target_invalid",
      `Persisted mux target field ${field} must be a non-empty string.`,
      { field },
    );
  }
  return candidate;
}

function parseMuxTarget(value: unknown): MuxTarget {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DispatchError(
      "session.mux_target_invalid",
      "Persisted mux target must be an object.",
    );
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== MUX_TARGET_VERSION ||
    record.backend !== "herdr" ||
    !Number.isSafeInteger(record.protocol) ||
    (record.protocol as number) <= 0
  ) {
    throw new DispatchError(
      "session.mux_target_invalid",
      "Persisted mux target has an unsupported identity envelope.",
      {
        version: record.version,
        backend: record.backend,
        protocol: record.protocol,
      },
    );
  }
  return {
    version: MUX_TARGET_VERSION,
    backend: "herdr",
    protocol: record.protocol as number,
    workspaceId: requiredString(record, "workspaceId"),
    tabId: requiredString(record, "tabId"),
    paneId: requiredString(record, "paneId"),
    terminalId: requiredString(record, "terminalId"),
    canonicalCwd: requiredString(record, "canonicalCwd"),
  };
}

function sameTarget(left: MuxTarget, right: MuxTarget): boolean {
  return (
    left.version === right.version &&
    left.backend === right.backend &&
    left.protocol === right.protocol &&
    left.workspaceId === right.workspaceId &&
    left.tabId === right.tabId &&
    left.paneId === right.paneId &&
    left.terminalId === right.terminalId &&
    left.canonicalCwd === right.canonicalCwd
  );
}

function assertStatusTarget(
  sid: string,
  expected: MuxTarget,
  status: MuxStatus,
): void {
  if (sameTarget(status.target, expected)) return;
  throw new MuxError(
    "conflict",
    `Mux status returned a different target generation for session ${sid}.`,
    {
      sid,
      expected: targetData(expected),
      actual: targetData(status.target),
    },
  );
}

function assertTargetCwd(
  sid: string,
  target: MuxTarget,
  canonicalCwd: string,
): void {
  if (pathKey(target.canonicalCwd) === pathKey(canonicalCwd)) return;
  throw new MuxError(
    "conflict",
    `Mux target cwd does not match session ${sid}.`,
    {
      sid,
      expectedCwd: canonicalCwd,
      actualCwd: target.canonicalCwd,
      muxTarget: targetData(target),
    },
  );
}

function latestMuxTarget(
  history: readonly ReadableEvent[],
): MuxTarget | undefined {
  return latestMuxTargetReceipt(history)?.target;
}

interface MuxTargetReceipt {
  readonly seq: number;
  readonly target: MuxTarget;
}

function latestMuxTargetReceipt(
  history: readonly ReadableEvent[],
): MuxTargetReceipt | undefined {
  for (let position = history.length - 1; position >= 0; position -= 1) {
    const event = history[position];
    if (
      !event ||
      (event.kind !== "session.opened" && event.kind !== "session.closed") ||
      event.data.muxTarget === undefined
    ) {
      continue;
    }
    return { seq: event.seq, target: parseMuxTarget(event.data.muxTarget) };
  }
  return undefined;
}

interface TerminalCloseReceipt {
  readonly seq: number;
  readonly outcome: MuxCloseResult["outcome"] | "not_found";
  readonly target?: MuxTarget;
}

function parseMuxCloseOutcome(
  value: unknown,
): MuxCloseResult["outcome"] | "not_found" {
  if (value === "closed" || value === "already_absent" || value === "not_found") {
    return value;
  }
  throw new DispatchError(
    "session.mux_close_receipt_invalid",
    "Persisted terminal-close receipt has an invalid mux outcome.",
    { muxOutcome: value },
  );
}

function latestTerminalCloseReceipt(
  history: readonly ReadableEvent[],
): TerminalCloseReceipt | undefined {
  for (let position = history.length - 1; position >= 0; position -= 1) {
    const event = history[position];
    if (
      !event ||
      event.kind !== "session.closed" ||
      event.data.reason !== "terminal-closed"
    ) {
      continue;
    }
    return {
      seq: event.seq,
      outcome: parseMuxCloseOutcome(event.data.muxOutcome),
      ...(event.data.muxTarget === undefined
        ? {}
        : { target: parseMuxTarget(event.data.muxTarget) }),
    };
  }
  return undefined;
}

function terminalCloseForCurrentTarget(
  history: readonly ReadableEvent[],
  target: MuxTarget | undefined,
): TerminalCloseReceipt | undefined {
  const closeReceipt = latestTerminalCloseReceipt(history);
  if (!closeReceipt) return undefined;
  const targetReceipt = latestMuxTargetReceipt(history);
  if (target) {
    return closeReceipt.target !== undefined &&
      sameTarget(closeReceipt.target, target) &&
      closeReceipt.seq >= (targetReceipt?.seq ?? 0)
      ? closeReceipt
      : undefined;
  }
  return closeReceipt.target === undefined && targetReceipt === undefined
    ? closeReceipt
    : undefined;
}

function terminalCloseCovers(
  history: readonly ReadableEvent[],
  target: MuxTarget | undefined,
  outcome: MuxCloseResult["outcome"] | "not_found",
): boolean {
  if (outcome === "closed") return false;
  return terminalCloseForCurrentTarget(history, target) !== undefined;
}

function hasMatchingTerminalCloseAfter(
  history: readonly ReadableEvent[],
  afterSeq: number,
  target: MuxTarget | undefined,
  outcome: MuxCloseResult["outcome"] | "not_found",
): boolean {
  return history.some((event) => {
    if (
      event.seq <= afterSeq ||
      event.kind !== "session.closed" ||
      event.data.reason !== "terminal-closed" ||
      event.data.muxOutcome !== outcome
    ) {
      return false;
    }
    if (!target) return event.data.muxTarget === undefined;
    return (
      event.data.muxTarget !== undefined &&
      sameTarget(parseMuxTarget(event.data.muxTarget), target)
    );
  });
}

function dispatchLifecycle(
  history: readonly ReadableEvent[],
): DispatchTerminalLifecycle {
  if (history.some((event) => event.kind === "worktree.removed")) {
    return "removed";
  }
  if (
    history.some(
      (event) =>
        event.kind === "session.closed" ||
        event.kind === "git.merged" ||
        event.kind === "outcome.recorded",
    )
  ) {
    return "closed";
  }
  if (history.some((event) => event.kind === "session.opened")) {
    return "opened";
  }
  return "created";
}

function openProjection(
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
      // The projection is already unusable; the ledger remains authoritative.
    }
    warnings.push(`index projection failed: ${errorMessage(error)}`);
    return undefined;
  }
}

function closeProjection(
  index: SessionIndex | undefined,
  warnings: string[],
): void {
  try {
    index?.close();
  } catch (error) {
    warnings.push(`index projection close failed: ${errorMessage(error)}`);
  }
}

async function appendOpenedReceipt(
  paths: DispatchPaths,
  config: DispatchConfig,
  meta: SessionMeta,
  ensured: MuxEnsureResult,
  warnings: string[],
  retryOperation: "open" | "close" = "open",
): Promise<OpenTerminalSessionResult["receipt"]> {
  const index = openProjection(paths, meta, warnings);
  try {
    try {
      const appended = await appendSessionEvent(
        paths,
        config,
        meta,
        {
          src: "dsp",
          kind: "session.opened",
          data: {
            muxTarget: targetData(ensured.target),
            action: ensured.disposition,
          },
        },
        index,
      );
      if (appended.projectionError) {
        warnings.push(
          `index projection failed: ${errorMessage(appended.projectionError)}`,
        );
      }
      return "recorded";
    } catch (error) {
      const recoveredHistory = await readSessionHistory(paths, meta.sid);
      const recoveredTarget = latestMuxTarget(recoveredHistory);
      if (recoveredTarget && sameTarget(recoveredTarget, ensured.target)) {
        try {
          index?.restoreSession(meta, recoveredHistory);
        } catch (projectionError) {
          warnings.push(
            `index projection failed: ${errorMessage(projectionError)}`,
          );
        }
        return "recovered_after_append";
      }
      throw new DispatchError(
        "session.mux_receipt_failed",
        `Terminal target was ensured for session ${meta.sid}, but its ledger receipt was not committed. Retry ${retryOperation} to reconcile it.`,
        { sid: meta.sid, muxTarget: targetData(ensured.target) },
        { cause: error },
      );
    }
  } finally {
    closeProjection(index, warnings);
  }
}

async function appendClosedReceipt(
  paths: DispatchPaths,
  config: DispatchConfig,
  meta: SessionMeta,
  target: MuxTarget | undefined,
  outcome: MuxCloseResult["outcome"] | "not_found",
  afterSeq: number,
  warnings: string[],
): Promise<CloseTerminalSessionResult["receipt"]> {
  const index = openProjection(paths, meta, warnings);
  try {
    try {
      const appended = await appendSessionEvent(
        paths,
        config,
        meta,
        {
          src: "dsp",
          kind: "session.closed",
          data: {
            reason: "terminal-closed",
            muxOutcome: outcome,
            ...(target ? { muxTarget: targetData(target) } : {}),
          },
        },
        index,
      );
      if (appended.projectionError) {
        warnings.push(
          `index projection failed: ${errorMessage(appended.projectionError)}`,
        );
      }
      return "recorded";
    } catch (error) {
      const recoveredHistory = await readSessionHistory(paths, meta.sid);
      if (
        hasMatchingTerminalCloseAfter(
          recoveredHistory,
          afterSeq,
          target,
          outcome,
        )
      ) {
        try {
          index?.restoreSession(meta, recoveredHistory);
        } catch (projectionError) {
          warnings.push(
            `index projection failed: ${errorMessage(projectionError)}`,
          );
        }
        return "recovered_after_append";
      }
      throw new DispatchError(
        "session.mux_close_receipt_failed",
        `Terminal backend closed session ${meta.sid}, but its terminal ledger receipt was not committed. Retry close to reconcile it.`,
        { sid: meta.sid, ...(target ? { muxTarget: targetData(target) } : {}) },
        { cause: error },
      );
    }
  } finally {
    closeProjection(index, warnings);
  }
}

export async function openTerminalSession(
  sid: string,
  mux: MuxPort,
  options: TerminalSessionOptions = {},
): Promise<OpenTerminalSessionResult> {
  const app = context(options);
  ensureStateDirectories(app.paths);
  const meta = readSessionMeta(app.paths, sid);
  const config = loadConfig(app.paths, meta.repositoryPath, app.env);

  return withExclusiveFileLock(
    `${sessionEventsPath(app.paths, sid)}.lifecycle`,
    async () => {
      const history = await readSessionHistory(app.paths, sid);
      const lifecycle = dispatchLifecycle(history);
      if (lifecycle === "closed" || lifecycle === "removed") {
        throw new DispatchError(
          "session.terminal_open_forbidden",
          `Cannot open terminal orchestration for ${lifecycle} session ${sid}.`,
          { sid, dispatchLifecycle: lifecycle },
        );
      }

      const canonicalCwd = physicalPath(meta.worktreePath);
      const existingTarget = latestMuxTarget(history);
      let ensured: MuxEnsureResult;
      if (existingTarget) {
        assertTargetCwd(sid, existingTarget, canonicalCwd);
        const persistedStatus = await mux.status(existingTarget);
        assertStatusTarget(sid, existingTarget, persistedStatus);
        ensured =
          persistedStatus.state === "running"
            ? { target: existingTarget, disposition: "recovered" }
            : await mux.ensure({
                logicalKey: logicalKey(sid),
                canonicalCwd,
                environment: { DISPATCH_SESSION_ID: sid },
              });
      } else {
        ensured = await mux.ensure({
          logicalKey: logicalKey(sid),
          canonicalCwd,
          environment: { DISPATCH_SESSION_ID: sid },
        });
      }
      assertTargetCwd(sid, ensured.target, canonicalCwd);
      const connected = await mux.reconnect(ensured.target);
      if (connected.state !== "running") {
        throw new DispatchError(
          "session.mux_open_unconfirmed",
          `Mux target for session ${sid} was not running after reconnect.`,
          { sid, muxTarget: targetData(ensured.target) },
        );
      }
      if (!sameTarget(connected.target, ensured.target)) {
        throw new MuxError(
          "conflict",
          `Mux reconnect returned a different target generation for session ${sid}.`,
          {
            sid,
            expected: targetData(ensured.target),
            actual: targetData(connected.target),
          },
        );
      }

      const warnings: string[] = [];
      const receipt =
        existingTarget && sameTarget(existingTarget, ensured.target)
          ? "already_recorded"
          : await appendOpenedReceipt(
              app.paths,
              config,
              meta,
              ensured,
              warnings,
            );

      return {
        sid,
        target: ensured.target,
        disposition: ensured.disposition,
        receipt,
        muxStatus: connected,
        projectionWarnings: warnings,
      };
    },
    { timeoutMs: config.ledger.lockTimeoutMs },
  );
}

export async function terminalSessionStatus(
  sid: string,
  mux: MuxPort,
  options: TerminalSessionOptions = {},
): Promise<TerminalSessionStatusResult> {
  const app = context(options);
  ensureStateDirectories(app.paths);
  const meta = readSessionMeta(app.paths, sid);
  const config = loadConfig(app.paths, meta.repositoryPath, app.env);
  return withExclusiveFileLock(
    `${sessionEventsPath(app.paths, sid)}.lifecycle`,
    async () => {
      const history = await readSessionHistory(app.paths, sid);
      const target = latestMuxTarget(history);
      let muxStatus: ApplicationMuxStatus = { state: "not_recorded" };
      if (target) {
        assertTargetCwd(sid, target, physicalPath(meta.worktreePath));
        muxStatus = await mux.status(target);
        assertStatusTarget(sid, target, muxStatus);
      }

      return {
        sid,
        dispatchLifecycle: dispatchLifecycle(history),
        lastSeq: history.at(-1)?.seq ?? 0,
        target: target ?? null,
        muxStatus,
      };
    },
    { timeoutMs: config.ledger.lockTimeoutMs },
  );
}

export async function closeTerminalSession(
  sid: string,
  mux: MuxPort,
  options: TerminalSessionOptions = {},
): Promise<CloseTerminalSessionResult> {
  const app = context(options);
  ensureStateDirectories(app.paths);
  const meta = readSessionMeta(app.paths, sid);
  const config = loadConfig(app.paths, meta.repositoryPath, app.env);

  return withExclusiveFileLock(
    `${sessionEventsPath(app.paths, sid)}.lifecycle`,
    async () => {
      const history = await readSessionHistory(app.paths, sid);
      const persistedTarget = latestMuxTarget(history);
      const completedClose = terminalCloseForCurrentTarget(
        history,
        persistedTarget,
      );
      if (completedClose) {
        return {
          sid,
          target: persistedTarget ?? null,
          muxOutcome: completedClose.outcome,
          alreadyClosed: true,
          receipt: "already_recorded",
          projectionWarnings: [],
        };
      }
      let target = persistedTarget;
      let adopted = false;
      const canonicalCwd = physicalPath(meta.worktreePath);

      const discovery = await mux.discover({
        logicalKey: logicalKey(sid),
        canonicalCwd,
      });
      if (discovery.kind === "ambiguous") {
        for (const candidate of discovery.candidates) {
          assertTargetCwd(sid, candidate, canonicalCwd);
        }
        if (persistedTarget) {
          assertTargetCwd(sid, persistedTarget, canonicalCwd);
          const persistedStatus = await mux.status(persistedTarget);
          assertStatusTarget(sid, persistedTarget, persistedStatus);
          if (
            persistedStatus.state === "running" &&
            discovery.candidates.length > 0 &&
            discovery.candidates.every(
              (candidate) =>
                candidate.workspaceId === persistedTarget.workspaceId,
            )
          ) {
            target = persistedTarget;
          } else {
            throw new MuxError(
              "ambiguous",
              `Multiple mux targets match session ${sid}; refusing terminal close.`,
              {
                sid,
                persisted: targetData(persistedTarget),
                persistedState: persistedStatus.state,
                candidates: discovery.candidates.map(targetData),
              },
            );
          }
        } else {
          throw new MuxError(
            "ambiguous",
            `Multiple mux targets match session ${sid}; refusing terminal close.`,
            { sid, candidates: discovery.candidates.map(targetData) },
          );
        }
      } else if (discovery.kind === "one") {
        assertTargetCwd(sid, discovery.target, canonicalCwd);
        if (persistedTarget && !sameTarget(persistedTarget, discovery.target)) {
          assertTargetCwd(sid, persistedTarget, canonicalCwd);
          const persistedStatus = await mux.status(persistedTarget);
          assertStatusTarget(sid, persistedTarget, persistedStatus);
          if (persistedStatus.state === "running") {
            if (
              persistedTarget.workspaceId === discovery.target.workspaceId
            ) {
              target = persistedTarget;
            } else {
              throw new MuxError(
                "conflict",
                `Persisted and discovered mux generations are both present for session ${sid}; refusing terminal close.`,
                {
                  sid,
                  persisted: targetData(persistedTarget),
                  discovered: targetData(discovery.target),
                },
              );
            }
          } else if (
            persistedTarget.workspaceId === discovery.target.workspaceId
          ) {
            throw new MuxError(
              "conflict",
              `Mux discovery contradicted the absent persisted workspace for session ${sid}; refusing terminal close.`,
              {
                sid,
                persisted: targetData(persistedTarget),
                discovered: targetData(discovery.target),
              },
            );
          } else {
            target = discovery.target;
            adopted = true;
          }
        } else if (!persistedTarget) {
          target = discovery.target;
          adopted = true;
        }
      }

      const warnings: string[] = [];
      if (adopted && target) {
        await appendOpenedReceipt(
          app.paths,
          config,
          meta,
          { target, disposition: "recovered" },
          warnings,
          "close",
        );
      }
      const receiptHistory = adopted
        ? await readSessionHistory(app.paths, sid)
        : history;

      let muxOutcome: MuxCloseResult["outcome"] | "not_found" = "not_found";
      if (target) {
        assertTargetCwd(sid, target, canonicalCwd);
        const closed = await mux.close(target);
        if (!sameTarget(closed.target, target)) {
          throw new MuxError(
            "conflict",
            `Mux close returned a different target generation for session ${sid}.`,
            {
              sid,
              expected: targetData(target),
              actual: targetData(closed.target),
            },
          );
        }
        muxOutcome = closed.outcome;
      }

      const alreadyClosed = terminalCloseCovers(
        receiptHistory,
        target,
        muxOutcome,
      );
      const receipt = alreadyClosed
        ? "already_recorded"
        : await appendClosedReceipt(
            app.paths,
            config,
            meta,
            target,
            muxOutcome,
            receiptHistory.at(-1)?.seq ?? 0,
            warnings,
          );

      return {
        sid,
        target: target ?? null,
        muxOutcome,
        alreadyClosed,
        receipt,
        projectionWarnings: warnings,
      };
    },
    { timeoutMs: config.ledger.lockTimeoutMs },
  );
}
