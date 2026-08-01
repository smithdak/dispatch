import { isAbsolute, win32 } from "node:path";

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
  MUX_TARGET_LEGACY_VERSION,
  MUX_TARGET_VERSION,
  MuxError,
  type MuxCloseResult,
  type MuxDiscovery,
  type MuxEnsureResult,
  type MuxPort,
  type MuxStatus,
  type MuxTarget,
  type MuxTargetV1,
  type MuxTargetV2,
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
  readonly allowRestoredGeneration?: boolean;
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
  readonly recovery: "restored_terminal" | null;
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
    ...(target.version === MUX_TARGET_VERSION
      ? {
          server: {
            session: target.server.session,
            socket: target.server.socket,
          },
        }
      : {}),
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
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.includes("\0")
  ) {
    throw new DispatchError(
      "session.mux_target_invalid",
      `Persisted mux target field ${field} must be a non-empty string.`,
      { field },
    );
  }
  return candidate;
}

function assertExactFields(
  value: Record<string, unknown>,
  expected: readonly string[],
  description: string,
): void {
  const expectedSet = new Set(expected);
  const actual = Object.keys(value);
  const unexpected = actual.filter((field) => !expectedSet.has(field));
  const missing = expected.filter((field) => !(field in value));
  if (unexpected.length === 0 && missing.length === 0) return;
  throw new DispatchError(
    "session.mux_target_invalid",
    `Persisted ${description} has unexpected or missing fields.`,
    { unexpected, missing },
  );
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
    (record.version !== MUX_TARGET_LEGACY_VERSION &&
      record.version !== MUX_TARGET_VERSION) ||
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
  assertExactFields(
    record,
    record.version === MUX_TARGET_LEGACY_VERSION
      ? [
          "version",
          "backend",
          "protocol",
          "workspaceId",
          "tabId",
          "paneId",
          "terminalId",
          "canonicalCwd",
        ]
      : [
          "version",
          "backend",
          "protocol",
          "server",
          "workspaceId",
          "tabId",
          "paneId",
          "terminalId",
          "canonicalCwd",
        ],
    "mux target",
  );
  const common = {
    backend: "herdr" as const,
    protocol: record.protocol as number,
    workspaceId: requiredString(record, "workspaceId"),
    tabId: requiredString(record, "tabId"),
    paneId: requiredString(record, "paneId"),
    terminalId: requiredString(record, "terminalId"),
    canonicalCwd: requiredString(record, "canonicalCwd"),
  };
  if (
    !isAbsolute(common.canonicalCwd) &&
    !win32.isAbsolute(common.canonicalCwd)
  ) {
    throw new DispatchError(
      "session.mux_target_invalid",
      "Persisted mux target canonicalCwd must be absolute.",
      { canonicalCwd: common.canonicalCwd },
    );
  }
  if (record.version === MUX_TARGET_LEGACY_VERSION) {
    return { version: MUX_TARGET_LEGACY_VERSION, ...common };
  }

  if (
    typeof record.server !== "object" ||
    record.server === null ||
    Array.isArray(record.server)
  ) {
    throw new DispatchError(
      "session.mux_target_invalid",
      "Persisted mux target server namespace must be an object.",
    );
  }
  const server = record.server as Record<string, unknown>;
  assertExactFields(server, ["session", "socket"], "mux server namespace");
  if (
    server.session !== null &&
    (typeof server.session !== "string" ||
      server.session.length === 0 ||
      server.session.includes("\0") ||
      /[\r\n]/.test(server.session))
  ) {
    throw new DispatchError(
      "session.mux_target_invalid",
      "Persisted mux target server session must be null or a non-empty string.",
    );
  }
  if (
    typeof server.socket !== "string" ||
    server.socket.length === 0 ||
    server.socket.includes("\0")
  ) {
    throw new DispatchError(
      "session.mux_target_invalid",
      "Persisted mux target server socket must be a non-empty string.",
    );
  }
  if (!isAbsolute(server.socket) && !win32.isAbsolute(server.socket)) {
    throw new DispatchError(
      "session.mux_target_invalid",
      "Persisted mux target server socket must be absolute.",
      { socket: server.socket },
    );
  }
  return {
    version: MUX_TARGET_VERSION,
    ...common,
    server: {
      session: server.session as string | null,
      socket: server.socket,
    },
  };
}

function sameTarget(left: MuxTarget, right: MuxTarget): boolean {
  const sameIdentity =
    left.backend === right.backend &&
    left.protocol === right.protocol &&
    left.workspaceId === right.workspaceId &&
    left.tabId === right.tabId &&
    left.paneId === right.paneId &&
    left.terminalId === right.terminalId &&
    left.canonicalCwd === right.canonicalCwd;
  if (!sameIdentity || left.version !== right.version) return false;
  if (
    left.version === MUX_TARGET_VERSION &&
    right.version === MUX_TARGET_VERSION
  ) {
    return (
      left.server.session === right.server.session &&
      left.server.socket === right.server.socket
    );
  }
  return left.version === MUX_TARGET_LEGACY_VERSION;
}

function sameWorkspace(left: MuxTarget, right: MuxTarget): boolean {
  if (left.workspaceId !== right.workspaceId) return false;
  if (
    left.version === MUX_TARGET_VERSION &&
    right.version === MUX_TARGET_VERSION
  ) {
    return (
      left.server.session === right.server.session &&
      left.server.socket === right.server.socket
    );
  }
  if (
    left.version === MUX_TARGET_LEGACY_VERSION &&
    right.version === MUX_TARGET_LEGACY_VERSION
  ) {
    return true;
  }
  if (left.version === MUX_TARGET_VERSION) {
    return left.server.session === null;
  }
  if (right.version === MUX_TARGET_VERSION) {
    return right.server.session === null;
  }
  return false;
}

function legacyBindingCandidate(
  legacy: MuxTargetV1,
  candidate: MuxTarget,
): candidate is MuxTargetV2 {
  return (
    candidate.version === MUX_TARGET_VERSION &&
    candidate.server.session === null &&
    candidate.backend === legacy.backend &&
    candidate.protocol === legacy.protocol &&
    candidate.workspaceId === legacy.workspaceId &&
    candidate.tabId === legacy.tabId &&
    candidate.paneId === legacy.paneId &&
    candidate.terminalId === legacy.terminalId &&
    pathKey(candidate.canonicalCwd) === pathKey(legacy.canonicalCwd)
  );
}

function legacyRestoredGenerationCandidate(
  legacy: MuxTargetV1,
  candidate: MuxTarget,
): candidate is MuxTargetV2 {
  return (
    candidate.version === MUX_TARGET_VERSION &&
    candidate.server.session === null &&
    candidate.backend === legacy.backend &&
    candidate.protocol === legacy.protocol &&
    candidate.workspaceId === legacy.workspaceId &&
    candidate.tabId === legacy.tabId &&
    candidate.paneId === legacy.paneId &&
    candidate.terminalId !== legacy.terminalId &&
    pathKey(candidate.canonicalCwd) === pathKey(legacy.canonicalCwd)
  );
}

function bindLegacyTarget(
  sid: string,
  legacy: MuxTargetV1,
  discovery: MuxDiscovery,
): MuxTargetV2 {
  const candidates = discovery.kind === "none"
    ? []
    : discovery.kind === "one"
    ? [discovery.target]
    : discovery.candidates;
  const matches = candidates.filter((candidate) =>
    legacyBindingCandidate(legacy, candidate)
  );
  if (matches.length === 1) return matches[0]!;
  throw new MuxError(
    matches.length > 1 ? "ambiguous" : "conflict",
    `Legacy mux target for session ${sid} could not be bound uniquely to the current default Herdr server namespace.`,
    {
      sid,
      legacy: targetData(legacy),
      candidates: candidates.map(targetData),
      matchingCandidates: matches.length,
    },
  );
}

function bindLegacyRestoredGeneration(
  sid: string,
  legacy: MuxTargetV1,
  discovery: MuxDiscovery,
): MuxTargetV2 {
  const candidates = discovery.kind === "none"
    ? []
    : discovery.kind === "one"
    ? [discovery.target]
    : discovery.candidates;
  const matches = candidates.filter((candidate) =>
    legacyRestoredGenerationCandidate(legacy, candidate)
  );
  if (matches.length === 1) return matches[0]!;
  throw new MuxError(
    matches.length > 1 ? "ambiguous" : "conflict",
    `Restarted legacy mux target for session ${sid} could not be bound uniquely to one new terminal generation on the current default Herdr server namespace.`,
    {
      sid,
      legacy: targetData(legacy),
      candidates: candidates.map(targetData),
      matchingCandidates: matches.length,
    },
  );
}

function restoredGenerationCandidate(
  previous: MuxTargetV2,
  candidate: MuxTarget,
): candidate is MuxTargetV2 {
  return (
    candidate.version === MUX_TARGET_VERSION &&
    candidate.backend === previous.backend &&
    candidate.protocol === previous.protocol &&
    candidate.server.session === previous.server.session &&
    candidate.server.socket === previous.server.socket &&
    candidate.workspaceId === previous.workspaceId &&
    candidate.tabId === previous.tabId &&
    candidate.paneId === previous.paneId &&
    candidate.terminalId !== previous.terminalId &&
    pathKey(candidate.canonicalCwd) === pathKey(previous.canonicalCwd)
  );
}

function bindRestoredGeneration(
  sid: string,
  previous: MuxTargetV2,
  discovery: MuxDiscovery,
): MuxTargetV2 {
  const candidates = discovery.kind === "none"
    ? []
    : discovery.kind === "one"
    ? [discovery.target]
    : discovery.candidates;
  const matches = candidates.filter((candidate) =>
    restoredGenerationCandidate(previous, candidate)
  );
  if (matches.length === 1) return matches[0]!;
  throw new MuxError(
    matches.length > 1 ? "ambiguous" : "conflict",
    `Restored mux target for session ${sid} could not be bound uniquely to one new terminal generation.`,
    {
      sid,
      previous: targetData(previous),
      candidates: candidates.map(targetData),
      matchingCandidates: matches.length,
    },
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
  restoredFrom?: MuxTarget,
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
            action: restoredFrom
              ? "restored_terminal"
              : ensured.disposition,
            ...(restoredFrom
              ? { previousMuxTarget: targetData(restoredFrom) }
              : {}),
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
      let ensured: MuxEnsureResult | undefined;
      let restoredFrom: MuxTarget | undefined;
      if (existingTarget) {
        assertTargetCwd(sid, existingTarget, canonicalCwd);
        let persistedStatus: MuxStatus | undefined;
        try {
          persistedStatus = await mux.status(existingTarget);
          assertStatusTarget(sid, existingTarget, persistedStatus);
        } catch (error) {
          if (
            !(error instanceof MuxError) ||
            error.code !== "conflict" ||
            !options.allowRestoredGeneration
          ) {
            throw error;
          }
          const discovery = await mux.discover({
            logicalKey: logicalKey(sid),
            canonicalCwd,
          });
          ensured = {
            target: existingTarget.version === MUX_TARGET_VERSION
              ? bindRestoredGeneration(sid, existingTarget, discovery)
              : bindLegacyRestoredGeneration(sid, existingTarget, discovery),
            disposition: "recovered",
          };
          restoredFrom = existingTarget;
        }
        if (!ensured) {
          if (persistedStatus?.state === "running") {
            const target = existingTarget.version === MUX_TARGET_LEGACY_VERSION
              ? bindLegacyTarget(
                  sid,
                  existingTarget,
                  await mux.discover({
                    logicalKey: logicalKey(sid),
                    canonicalCwd,
                  }),
                )
              : existingTarget;
            ensured = { target, disposition: "recovered" };
          } else {
            ensured = await mux.ensure({
              logicalKey: logicalKey(sid),
              canonicalCwd,
              environment: { DISPATCH_SESSION_ID: sid },
            });
          }
        }
      } else {
        ensured = await mux.ensure({
          logicalKey: logicalKey(sid),
          canonicalCwd,
          environment: { DISPATCH_SESSION_ID: sid },
        });
      }
      if (!ensured) {
        throw new DispatchError(
          "session.mux_open_unconfirmed",
          `Mux target for session ${sid} was not resolved.`,
          { sid },
        );
      }
      assertTargetCwd(sid, ensured.target, canonicalCwd);

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
              "open",
              restoredFrom,
            );

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

      return {
        sid,
        target: ensured.target,
        disposition: ensured.disposition,
        receipt,
        muxStatus: connected,
        recovery: restoredFrom ? "restored_terminal" : null,
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
      let restoredFrom: MuxTarget | undefined;
      const canonicalCwd = physicalPath(meta.worktreePath);

      const discovery = await mux.discover({
        logicalKey: logicalKey(sid),
        canonicalCwd,
      });
      let generationBound = false;
      if (
        options.allowRestoredGeneration &&
        persistedTarget?.version === MUX_TARGET_VERSION
      ) {
        const candidates = discovery.kind === "none"
          ? []
          : discovery.kind === "one"
          ? [discovery.target]
          : discovery.candidates;
        if (candidates.some((candidate) =>
          restoredGenerationCandidate(persistedTarget, candidate)
        )) {
          target = bindRestoredGeneration(sid, persistedTarget, discovery);
          adopted = true;
          restoredFrom = persistedTarget;
          generationBound = true;
        }
      }
      if (
        !generationBound &&
        persistedTarget?.version === MUX_TARGET_LEGACY_VERSION
      ) {
        assertTargetCwd(sid, persistedTarget, canonicalCwd);
        const candidates = discovery.kind === "none"
          ? []
          : discovery.kind === "one"
          ? [discovery.target]
          : discovery.candidates;
        if (
          options.allowRestoredGeneration &&
          candidates.some((candidate) =>
            legacyRestoredGenerationCandidate(persistedTarget, candidate)
          )
        ) {
          target = bindLegacyRestoredGeneration(sid, persistedTarget, discovery);
          adopted = true;
          restoredFrom = persistedTarget;
          generationBound = true;
        } else {
          const persistedStatus = await mux.status(persistedTarget);
          assertStatusTarget(sid, persistedTarget, persistedStatus);
          if (persistedStatus.state === "running") {
            target = bindLegacyTarget(sid, persistedTarget, discovery);
            adopted = true;
            generationBound = true;
          }
        }
      }

      if (!generationBound && discovery.kind === "ambiguous") {
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
              (candidate) => sameWorkspace(candidate, persistedTarget),
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
      } else if (!generationBound && discovery.kind === "one") {
        assertTargetCwd(sid, discovery.target, canonicalCwd);
        if (persistedTarget && !sameTarget(persistedTarget, discovery.target)) {
          assertTargetCwd(sid, persistedTarget, canonicalCwd);
          const persistedStatus = await mux.status(persistedTarget);
          assertStatusTarget(sid, persistedTarget, persistedStatus);
          if (persistedStatus.state === "running") {
            if (sameWorkspace(persistedTarget, discovery.target)) {
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
          } else if (sameWorkspace(persistedTarget, discovery.target)) {
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
          restoredFrom,
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
