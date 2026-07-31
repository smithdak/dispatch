import { isAbsolute, normalize, parse, win32 } from "node:path";

import {
  MUX_TARGET_VERSION,
  MuxError,
  type MuxCapabilities,
  type MuxCloseResult,
  type MuxDiscovery,
  type MuxDiscoveryRequest,
  type MuxEnsureRequest,
  type MuxEnsureResult,
  type MuxPort,
  type MuxStatus,
  type MuxTarget,
} from "../../ports/mux";

export const HERDR_PROTOCOL = 18;
export const HERDR_LABEL_PREFIX = "dispatch:";

export interface HerdrProcessInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly shell: false;
}

export interface HerdrProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type HerdrProcessRunner = (
  invocation: HerdrProcessInvocation,
) => Promise<HerdrProcessResult>;

export interface HerdrMuxOptions {
  readonly executable?: string;
  readonly runner?: HerdrProcessRunner;
}

type JsonRecord = Record<string, unknown>;

interface HerdrSnapshot {
  readonly workspaces: readonly unknown[];
  readonly tabs: readonly unknown[];
  readonly panes: readonly unknown[];
}

type MutationAttempt =
  | { readonly kind: "success"; readonly payload: unknown }
  | { readonly kind: "known_failure"; readonly error: MuxError }
  | {
      readonly kind: "unknown";
      readonly reason: string;
      readonly details: Readonly<Record<string, unknown>>;
    };

const defaultRunner: HerdrProcessRunner = async (invocation) => {
  const child = Bun.spawn(
    [invocation.executable, ...invocation.args],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredRecord(
  value: unknown,
  path: string,
  command: string,
): JsonRecord {
  if (!isRecord(value)) {
    throw invalidResponse(command, `${path} must be an object.`);
  }
  return value;
}

function requiredArray(
  value: unknown,
  path: string,
  command: string,
): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw invalidResponse(command, `${path} must be an array.`);
  }
  return value;
}

function requiredString(
  value: unknown,
  path: string,
  command: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidResponse(command, `${path} must be a non-empty string.`);
  }
  return value;
}

function requiredBoolean(
  value: unknown,
  path: string,
  command: string,
): boolean {
  if (typeof value !== "boolean") {
    throw invalidResponse(command, `${path} must be a boolean.`);
  }
  return value;
}

function requiredInteger(
  value: unknown,
  path: string,
  command: string,
): number {
  if (!Number.isInteger(value)) {
    throw invalidResponse(command, `${path} must be an integer.`);
  }
  return value as number;
}

function invalidResponse(
  command: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
  options?: ErrorOptions,
): MuxError {
  return new MuxError(
    "invalid_response",
    `Invalid Herdr response for ${command}: ${message}`,
    { command, ...details },
    options,
  );
}

function parseJson(value: string, command: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw invalidResponse(
      command,
      "stdout was not valid JSON.",
      { stdout: value },
      { cause: error },
    );
  }
}

function parseErrorEnvelope(value: string): { code: string; message: string } | null {
  if (value.trim().length === 0) return null;
  try {
    const envelope = JSON.parse(value) as unknown;
    if (!isRecord(envelope) || !isRecord(envelope.error)) return null;
    if (
      typeof envelope.error.code !== "string" ||
      typeof envelope.error.message !== "string"
    ) {
      return null;
    }
    return {
      code: envelope.error.code,
      message: envelope.error.message,
    };
  } catch {
    return null;
  }
}

function domainError(
  command: string,
  error: { code: string; message: string },
): MuxError {
  if (error.code.includes("protocol") || error.code.includes("incompatible")) {
    return new MuxError(
      "incompatible",
      `Herdr rejected ${command}: ${error.message}`,
      { command, herdrCode: error.code },
    );
  }
  if (
    error.code.includes("unavailable") ||
    error.code.includes("server") ||
    error.code.includes("socket")
  ) {
    return new MuxError(
      "unavailable",
      `Herdr could not execute ${command}: ${error.message}`,
      { command, herdrCode: error.code },
    );
  }
  if (error.code.endsWith("_not_found")) {
    return new MuxError(
      "conflict",
      `Herdr target changed while executing ${command}: ${error.message}`,
      { command, herdrCode: error.code },
    );
  }
  return invalidResponse(command, error.message, { herdrCode: error.code });
}

function commandName(args: readonly string[]): string {
  return `herdr ${args.join(" ")}`;
}

function isAbsoluteExecutable(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value);
}

function pathIdentity(value: string): string {
  if (win32.isAbsolute(value)) {
    const normalized = win32.normalize(value);
    const withoutTrailingSeparators = normalized === win32.parse(normalized).root
      ? normalized
      : normalized.replace(/[\\/]+$/, "");
    return withoutTrailingSeparators.toLowerCase();
  }
  const normalized = normalize(value);
  return normalized === parse(normalized).root
    ? normalized
    : normalized.replace(/[\\/]+$/, "");
}

function validateDiscoveryRequest(request: MuxDiscoveryRequest): void {
  if (
    request.logicalKey.length === 0 ||
    request.logicalKey.includes("\0") ||
    /[\r\n]/.test(request.logicalKey)
  ) {
    throw new MuxError(
      "invalid_response",
      "Mux logical key must be a non-empty single-line value.",
    );
  }
  if (
    request.canonicalCwd.length === 0 ||
    request.canonicalCwd.includes("\0") ||
    (!isAbsolute(request.canonicalCwd) && !win32.isAbsolute(request.canonicalCwd))
  ) {
    throw new MuxError(
      "invalid_response",
      "Mux canonical cwd must be an absolute path.",
      { canonicalCwd: request.canonicalCwd },
    );
  }
}

function validateEnvironment(
  environment: Readonly<Record<string, string>> | undefined,
): void {
  if (!environment) return;
  for (const [key, value] of Object.entries(environment)) {
    if (key.length === 0 || key.includes("=") || key.includes("\0")) {
      throw new MuxError(
        "invalid_response",
        `Invalid Herdr environment key: ${JSON.stringify(key)}.`,
      );
    }
    if (value.includes("\0")) {
      throw new MuxError(
        "invalid_response",
        `Herdr environment value for ${JSON.stringify(key)} contains NUL.`,
      );
    }
  }
}

function validateTarget(target: MuxTarget): void {
  if (
    target.version !== MUX_TARGET_VERSION ||
    target.backend !== "herdr" ||
    target.protocol !== HERDR_PROTOCOL
  ) {
    throw new MuxError(
      "incompatible",
      "Persisted mux target is not compatible with this Herdr adapter.",
      {
        version: target.version,
        backend: target.backend,
        protocol: target.protocol,
      },
    );
  }
  for (const [name, value] of Object.entries({
    workspaceId: target.workspaceId,
    tabId: target.tabId,
    paneId: target.paneId,
    terminalId: target.terminalId,
    canonicalCwd: target.canonicalCwd,
  })) {
    if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
      throw new MuxError(
        "invalid_response",
        `Persisted mux target has an invalid ${name}.`,
      );
    }
  }
  if (
    !isAbsolute(target.canonicalCwd) &&
    !win32.isAbsolute(target.canonicalCwd)
  ) {
    throw new MuxError(
      "invalid_response",
      "Persisted mux target cwd must be absolute.",
      { canonicalCwd: target.canonicalCwd },
    );
  }
}

function labelFor(logicalKey: string): string {
  return `${HERDR_LABEL_PREFIX}${logicalKey}`;
}

function successResult(payload: unknown, command: string): JsonRecord {
  const envelope = requiredRecord(payload, "$", command);
  requiredString(envelope.id, "$.id", command);
  return requiredRecord(envelope.result, "$.result", command);
}

function targetConflict(
  target: MuxTarget,
  field: string,
  actual: unknown,
): MuxError {
  return new MuxError(
    "conflict",
    `Herdr ${field} no longer matches the persisted mux target.`,
    { target, field, actual },
  );
}

export class HerdrMuxAdapter implements MuxPort {
  readonly #executable: string | null;
  readonly #runner: HerdrProcessRunner;

  constructor(options: HerdrMuxOptions = {}) {
    const executable = options.executable ?? Bun.which("herdr");
    if (executable && !isAbsoluteExecutable(executable)) {
      throw new MuxError(
        "invalid_response",
        "Herdr executable must be an absolute path.",
        { executable },
      );
    }
    this.#executable = executable;
    this.#runner = options.runner ?? defaultRunner;
  }

  async probe(): Promise<MuxCapabilities> {
    const command = "herdr status --json";
    const payload = requiredRecord(
      await this.#readJson(["status", "--json"]),
      "$",
      command,
    );
    const client = requiredRecord(payload.client, "$.client", command);
    const server = requiredRecord(payload.server, "$.server", command);
    const capabilities = requiredRecord(
      server.capabilities,
      "$.server.capabilities",
      command,
    );

    const running = requiredBoolean(
      server.running,
      "$.server.running",
      command,
    );
    if (!running) {
      throw new MuxError("unavailable", "Herdr server is not running.", {
        status: server.status,
      });
    }

    const compatible = requiredBoolean(
      server.compatible,
      "$.server.compatible",
      command,
    );
    const clientProtocol = requiredInteger(
      client.protocol,
      "$.client.protocol",
      command,
    );
    const serverProtocol = requiredInteger(
      server.protocol,
      "$.server.protocol",
      command,
    );
    if (
      !compatible ||
      clientProtocol !== HERDR_PROTOCOL ||
      serverProtocol !== HERDR_PROTOCOL
    ) {
      throw new MuxError(
        "incompatible",
        `Herdr protocol ${HERDR_PROTOCOL} is required.`,
        { compatible, clientProtocol, serverProtocol },
      );
    }

    const reportedBinary = requiredString(
      client.binary,
      "$.client.binary",
      command,
    );
    if (!isAbsoluteExecutable(reportedBinary)) {
      throw invalidResponse(command, "$.client.binary must be absolute.");
    }

    return {
      backend: "herdr",
      executable: this.#requiredExecutable(),
      channel: requiredString(client.channel, "$.client.channel", command),
      clientVersion: requiredString(
        client.version,
        "$.client.version",
        command,
      ),
      serverVersion: requiredString(
        server.version,
        "$.server.version",
        command,
      ),
      protocol: HERDR_PROTOCOL,
      detachedServerDaemon: requiredBoolean(
        capabilities.detached_server_daemon,
        "$.server.capabilities.detached_server_daemon",
        command,
      ),
      liveHandoff: requiredBoolean(
        capabilities.live_handoff,
        "$.server.capabilities.live_handoff",
        command,
      ),
    };
  }

  async discover(request: MuxDiscoveryRequest): Promise<MuxDiscovery> {
    validateDiscoveryRequest(request);
    const snapshot = await this.#snapshot();
    const command = "herdr api snapshot";
    const expectedLabel = labelFor(request.logicalKey);
    const expectedCwd = pathIdentity(request.canonicalCwd);
    const candidates: MuxTarget[] = [];
    const seen = new Set<string>();

    for (const workspaceValue of snapshot.workspaces) {
      const workspace = requiredRecord(
        workspaceValue,
        "$.result.snapshot.workspaces[]",
        command,
      );
      if (workspace.label !== expectedLabel) continue;
      const workspaceId = requiredString(
        workspace.workspace_id,
        "$.result.snapshot.workspaces[].workspace_id",
        command,
      );

      for (const paneValue of snapshot.panes) {
        const pane = requiredRecord(
          paneValue,
          "$.result.snapshot.panes[]",
          command,
        );
        if (pane.workspace_id !== workspaceId) continue;
        if (
          typeof pane.cwd !== "string" ||
          pathIdentity(pane.cwd) !== expectedCwd
        ) {
          continue;
        }

        const tabId = requiredString(
          pane.tab_id,
          "$.result.snapshot.panes[].tab_id",
          command,
        );
        const matchingTabs = snapshot.tabs.filter((tabValue) => {
          if (!isRecord(tabValue)) return false;
          return tabValue.tab_id === tabId && tabValue.workspace_id === workspaceId;
        });
        if (matchingTabs.length !== 1) {
          throw invalidResponse(
            command,
            "matching pane must have exactly one matching tab.",
            { workspaceId, tabId, matchingTabCount: matchingTabs.length },
          );
        }

        const target: MuxTarget = {
          version: MUX_TARGET_VERSION,
          backend: "herdr",
          protocol: HERDR_PROTOCOL,
          workspaceId,
          tabId,
          paneId: requiredString(
            pane.pane_id,
            "$.result.snapshot.panes[].pane_id",
            command,
          ),
          terminalId: requiredString(
            pane.terminal_id,
            "$.result.snapshot.panes[].terminal_id",
            command,
          ),
          canonicalCwd: request.canonicalCwd,
        };
        const identity = [
          target.workspaceId,
          target.tabId,
          target.paneId,
          target.terminalId,
        ].join("\0");
        if (seen.has(identity)) {
          throw invalidResponse(command, "snapshot contains a duplicate target.", {
            identity,
          });
        }
        seen.add(identity);
        candidates.push(target);
      }
    }

    if (candidates.length === 0) return { kind: "none" };
    if (candidates.length === 1) {
      const target = candidates[0];
      if (!target) throw invalidResponse(command, "candidate disappeared.");
      return { kind: "one", target };
    }
    return { kind: "ambiguous", candidates };
  }

  async ensure(request: MuxEnsureRequest): Promise<MuxEnsureResult> {
    validateDiscoveryRequest(request);
    validateEnvironment(request.environment);
    const discovery = await this.discover(request);
    if (discovery.kind === "one") {
      return { target: discovery.target, disposition: "recovered" };
    }
    if (discovery.kind === "ambiguous") {
      throw this.#ambiguous(request, discovery.candidates);
    }
    return this.#createAndReconcile(request, true);
  }

  async status(target: MuxTarget): Promise<MuxStatus> {
    validateTarget(target);
    const snapshot = await this.#snapshot();
    const command = "herdr api snapshot";
    const workspaces = snapshot.workspaces.filter(
      (value) => isRecord(value) && value.workspace_id === target.workspaceId,
    );
    if (workspaces.length === 0) return { state: "absent", target };
    if (workspaces.length !== 1) {
      throw invalidResponse(command, "snapshot contains duplicate workspace IDs.", {
        workspaceId: target.workspaceId,
      });
    }
    const workspace = requiredRecord(workspaces[0], "workspace", command);

    const panes = snapshot.panes.filter(
      (value) => isRecord(value) && value.pane_id === target.paneId,
    );
    if (panes.length !== 1) {
      if (panes.length > 1) {
        throw invalidResponse(command, "snapshot contains duplicate pane IDs.", {
          paneId: target.paneId,
        });
      }
      throw targetConflict(target, "pane_id", undefined);
    }
    const pane = requiredRecord(panes[0], "pane", command);

    const tabs = snapshot.tabs.filter(
      (value) => isRecord(value) && value.tab_id === target.tabId,
    );
    if (tabs.length !== 1) {
      if (tabs.length > 1) {
        throw invalidResponse(command, "snapshot contains duplicate tab IDs.", {
          tabId: target.tabId,
        });
      }
      throw targetConflict(target, "tab_id", undefined);
    }
    const tab = requiredRecord(tabs[0], "tab", command);

    const checks: ReadonlyArray<readonly [string, unknown, string]> = [
      ["pane.workspace_id", pane.workspace_id, target.workspaceId],
      ["pane.tab_id", pane.tab_id, target.tabId],
      ["pane.terminal_id", pane.terminal_id, target.terminalId],
      ["tab.workspace_id", tab.workspace_id, target.workspaceId],
    ];
    for (const [field, actual, expected] of checks) {
      if (actual !== expected) throw targetConflict(target, field, actual);
    }
    if (
      typeof pane.cwd !== "string" ||
      pathIdentity(pane.cwd) !== pathIdentity(target.canonicalCwd)
    ) {
      throw targetConflict(target, "pane.cwd", pane.cwd);
    }

    const focused = requiredBoolean(workspace.focused, "workspace.focused", command);
    if (typeof pane.agent_status === "string") {
      return {
        state: "running",
        target,
        focused,
        agentStatus: pane.agent_status,
      };
    }
    return { state: "running", target, focused };
  }

  async reconnect(target: MuxTarget): Promise<MuxStatus> {
    const before = await this.status(target);
    if (before.state === "absent") return before;

    let attempt = await this.#mutate([
      "workspace",
      "focus",
      target.workspaceId,
    ]);
    if (attempt.kind === "success") {
      try {
        successResult(attempt.payload, "herdr workspace focus");
      } catch (error) {
        attempt = {
          kind: "unknown",
          reason: "focus returned an invalid success envelope",
          details: { error: error instanceof Error ? error.message : String(error) },
        };
      }
    }

    let after: MuxStatus;
    try {
      after = await this.status(target);
    } catch (error) {
      if (error instanceof MuxError && error.code === "conflict") throw error;
      throw this.#outcomeUnknown(
        "Could not reconcile Herdr focus with a fresh snapshot.",
        attempt,
        error,
      );
    }
    if (after.state === "absent") return after;
    if (after.focused) return after;
    if (attempt.kind === "known_failure") throw attempt.error;
    throw this.#outcomeUnknown(
      "Herdr workspace was not focused after reconnect.",
      attempt,
    );
  }

  async close(target: MuxTarget): Promise<MuxCloseResult> {
    const before = await this.status(target);
    if (before.state === "absent") {
      return { outcome: "already_absent", target };
    }
    return this.#closeAndReconcile(target, true);
  }

  async #snapshot(): Promise<HerdrSnapshot> {
    await this.probe();
    const command = "herdr api snapshot";
    const envelope = requiredRecord(
      await this.#readJson(["api", "snapshot"]),
      "$",
      command,
    );
    requiredString(envelope.id, "$.id", command);
    const result = requiredRecord(envelope.result, "$.result", command);
    if (result.type !== "session_snapshot") {
      throw invalidResponse(command, "$.result.type must be session_snapshot.", {
        type: result.type,
      });
    }
    const snapshot = requiredRecord(
      result.snapshot,
      "$.result.snapshot",
      command,
    );
    const protocol = requiredInteger(
      snapshot.protocol,
      "$.result.snapshot.protocol",
      command,
    );
    if (protocol !== HERDR_PROTOCOL) {
      throw new MuxError(
        "incompatible",
        `Herdr snapshot protocol ${protocol} is not supported.`,
        { expectedProtocol: HERDR_PROTOCOL, protocol },
      );
    }
    return {
      workspaces: requiredArray(
        snapshot.workspaces,
        "$.result.snapshot.workspaces",
        command,
      ),
      tabs: requiredArray(snapshot.tabs, "$.result.snapshot.tabs", command),
      panes: requiredArray(snapshot.panes, "$.result.snapshot.panes", command),
    };
  }

  async #createAndReconcile(
    request: MuxEnsureRequest,
    retryAllowed: boolean,
  ): Promise<MuxEnsureResult> {
    const environment = {
      ...request.environment,
      DISPATCH_SESSION_ID: request.logicalKey,
    };
    const args = [
      "workspace",
      "create",
      "--cwd",
      request.canonicalCwd,
      "--label",
      labelFor(request.logicalKey),
    ];
    for (const [key, value] of Object.entries(environment).sort(([left], [right]) =>
      left.localeCompare(right)
    )) {
      args.push("--env", `${key}=${value}`);
    }
    args.push("--no-focus");

    let attempt = await this.#mutate(args);
    if (attempt.kind === "known_failure") throw attempt.error;
    if (attempt.kind === "success") {
      try {
        return {
          target: this.#createdTarget(attempt.payload, request),
          disposition: "created",
        };
      } catch (error) {
        if (error instanceof MuxError && error.code === "conflict") throw error;
        attempt = {
          kind: "unknown",
          reason: "create returned an invalid success receipt",
          details: { error: error instanceof Error ? error.message : String(error) },
        };
      }
    }

    let discovery: MuxDiscovery;
    try {
      discovery = await this.discover(request);
    } catch (error) {
      throw this.#outcomeUnknown(
        "Could not reconcile Herdr workspace creation with a fresh snapshot.",
        attempt,
        error,
      );
    }
    if (discovery.kind === "one") {
      return { target: discovery.target, disposition: "recovered" };
    }
    if (discovery.kind === "ambiguous") {
      throw this.#ambiguous(request, discovery.candidates);
    }
    if (retryAllowed) return this.#createAndReconcile(request, false);
    throw this.#outcomeUnknown(
      "Herdr create outcome remained unknown after snapshot reconciliation and one safe retry.",
      attempt,
    );
  }

  #createdTarget(payload: unknown, request: MuxEnsureRequest): MuxTarget {
    const command = "herdr workspace create";
    const result = successResult(payload, command);
    if (result.type !== "workspace_created") {
      throw invalidResponse(command, "$.result.type must be workspace_created.", {
        type: result.type,
      });
    }
    const workspace = requiredRecord(result.workspace, "$.result.workspace", command);
    const tab = requiredRecord(result.tab, "$.result.tab", command);
    const pane = requiredRecord(result.root_pane, "$.result.root_pane", command);
    const workspaceId = requiredString(
      workspace.workspace_id,
      "$.result.workspace.workspace_id",
      command,
    );
    const tabId = requiredString(tab.tab_id, "$.result.tab.tab_id", command);
    const paneWorkspaceId = requiredString(
      pane.workspace_id,
      "$.result.root_pane.workspace_id",
      command,
    );
    const paneTabId = requiredString(
      pane.tab_id,
      "$.result.root_pane.tab_id",
      command,
    );
    if (
      tab.workspace_id !== workspaceId ||
      paneWorkspaceId !== workspaceId ||
      paneTabId !== tabId
    ) {
      throw new MuxError(
        "conflict",
        "Herdr create receipt contains inconsistent workspace, tab, or pane IDs.",
        { workspaceId, tabId, paneWorkspaceId, paneTabId },
      );
    }
    const workspaceLabel = requiredString(
      workspace.label,
      "$.result.workspace.label",
      command,
    );
    if (workspaceLabel !== labelFor(request.logicalKey)) {
      throw new MuxError(
        "conflict",
        "Herdr create receipt label does not match the requested session.",
        { expected: labelFor(request.logicalKey), actual: workspaceLabel },
      );
    }
    const paneCwd = requiredString(
      pane.cwd,
      "$.result.root_pane.cwd",
      command,
    );
    if (pathIdentity(paneCwd) !== pathIdentity(request.canonicalCwd)) {
      throw new MuxError(
        "conflict",
        "Herdr create receipt cwd does not match the requested worktree.",
        { expected: request.canonicalCwd, actual: paneCwd },
      );
    }
    return {
      version: MUX_TARGET_VERSION,
      backend: "herdr",
      protocol: HERDR_PROTOCOL,
      workspaceId,
      tabId,
      paneId: requiredString(
        pane.pane_id,
        "$.result.root_pane.pane_id",
        command,
      ),
      terminalId: requiredString(
        pane.terminal_id,
        "$.result.root_pane.terminal_id",
        command,
      ),
      canonicalCwd: request.canonicalCwd,
    };
  }

  async #closeAndReconcile(
    target: MuxTarget,
    retryAllowed: boolean,
  ): Promise<MuxCloseResult> {
    let attempt = await this.#mutate([
      "workspace",
      "close",
      target.workspaceId,
    ]);
    if (attempt.kind === "success") {
      try {
        successResult(attempt.payload, "herdr workspace close");
      } catch (error) {
        attempt = {
          kind: "unknown",
          reason: "close returned an invalid success envelope",
          details: { error: error instanceof Error ? error.message : String(error) },
        };
      }
    }

    let after: MuxStatus;
    try {
      after = await this.status(target);
    } catch (error) {
      if (error instanceof MuxError && error.code === "conflict") throw error;
      throw this.#outcomeUnknown(
        "Could not reconcile Herdr workspace close with a fresh snapshot.",
        attempt,
        error,
      );
    }
    if (after.state === "absent") return { outcome: "closed", target };
    if (attempt.kind === "known_failure") throw attempt.error;
    if (retryAllowed) return this.#closeAndReconcile(target, false);
    throw this.#outcomeUnknown(
      "Herdr close outcome remained unknown after snapshot reconciliation and one safe retry.",
      attempt,
    );
  }

  async #readJson(args: readonly string[]): Promise<unknown> {
    const command = commandName(args);
    let result: HerdrProcessResult;
    try {
      result = await this.#invoke(args);
    } catch (error) {
      throw new MuxError(
        "unavailable",
        `Could not start ${command}.`,
        { command },
        { cause: error },
      );
    }
    if (result.exitCode !== 0) {
      const error = parseErrorEnvelope(result.stderr);
      if (error) throw domainError(command, error);
      if (result.exitCode === 2) {
        throw invalidResponse(command, "Herdr rejected the adapter argv.", {
          exitCode: result.exitCode,
          stderr: result.stderr,
        });
      }
      throw new MuxError(
        "unavailable",
        `${command} failed before returning a structured result.`,
        {
          command,
          exitCode: result.exitCode,
          stderr: result.stderr,
        },
      );
    }
    if (result.stderr.trim().length > 0) {
      throw invalidResponse(command, "successful command wrote to stderr.", {
        stderr: result.stderr,
      });
    }
    return parseJson(result.stdout, command);
  }

  async #mutate(args: readonly string[]): Promise<MutationAttempt> {
    const command = commandName(args);
    let result: HerdrProcessResult;
    try {
      result = await this.#invoke(args);
    } catch (error) {
      return {
        kind: "unknown",
        reason: `could not observe ${command} completion`,
        details: { error: error instanceof Error ? error.message : String(error) },
      };
    }
    if (result.exitCode === 0) {
      if (result.stderr.trim().length > 0) {
        return {
          kind: "unknown",
          reason: `${command} wrote stderr on success`,
          details: { stderr: result.stderr },
        };
      }
      try {
        return { kind: "success", payload: parseJson(result.stdout, command) };
      } catch (error) {
        return {
          kind: "unknown",
          reason: `${command} returned invalid JSON after success`,
          details: { error: error instanceof Error ? error.message : String(error) },
        };
      }
    }

    const error = parseErrorEnvelope(result.stderr);
    if (error) {
      return { kind: "known_failure", error: domainError(command, error) };
    }
    if (result.exitCode === 2) {
      return {
        kind: "known_failure",
        error: invalidResponse(command, "Herdr rejected the adapter argv.", {
          exitCode: result.exitCode,
          stderr: result.stderr,
        }),
      };
    }
    return {
      kind: "unknown",
      reason: `${command} exited without a structured result`,
      details: {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      },
    };
  }

  async #invoke(args: readonly string[]): Promise<HerdrProcessResult> {
    return this.#runner({
      executable: this.#requiredExecutable(),
      args: [...args],
      shell: false,
    });
  }

  #requiredExecutable(): string {
    if (!this.#executable) {
      throw new MuxError(
        "unavailable",
        "Herdr executable was not found on PATH.",
      );
    }
    return this.#executable;
  }

  #ambiguous(
    request: MuxDiscoveryRequest,
    candidates: readonly MuxTarget[],
  ): MuxError {
    return new MuxError(
      "ambiguous",
      "More than one Herdr target matches the Dispatch session and cwd.",
      {
        logicalKey: request.logicalKey,
        canonicalCwd: request.canonicalCwd,
        candidates,
      },
    );
  }

  #outcomeUnknown(
    message: string,
    attempt: MutationAttempt,
    cause?: unknown,
  ): MuxError {
    const details =
      attempt.kind === "unknown"
        ? { reason: attempt.reason, ...attempt.details }
        : attempt.kind === "known_failure"
          ? { errorCode: attempt.error.code, error: attempt.error.message }
          : { responseObserved: true };
    return new MuxError(
      "outcome_unknown",
      message,
      details,
      cause === undefined ? undefined : { cause },
    );
  }
}

export function createHerdrMux(options: HerdrMuxOptions = {}): MuxPort {
  return new HerdrMuxAdapter(options);
}
