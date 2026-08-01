import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  win32,
} from "node:path";

import { isSortableId } from "../src/core/identity";
import {
  qualifyWindowsMux,
  type MuxTarget,
  type ProcessInvocation,
  type ProcessResult,
  type ProcessRunner,
  type WindowsMuxQualificationEvidence,
} from "./qualify-windows-mux";

export interface WindowsRestartQualificationOptions {
  readonly binary: string;
  readonly sid: string;
  readonly herdrSessionPrefix: string;
  readonly cycles?: number;
  readonly output?: string;
  readonly herdr?: string;
}

export type ServerStarter = (
  herdr: string,
  session: string,
) => void | Promise<void>;

export interface WindowsRestartQualificationDependencies {
  readonly runner?: ProcessRunner;
  readonly startServer?: ServerStarter;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly which?: (executable: string) => string | null;
  readonly executableExists?: (path: string) => boolean;
  readonly sha256?: (path: string) => string;
  readonly now?: () => Date;
  readonly writeEvidence?: (path: string, evidence: unknown) => void;
  readonly readinessAttempts?: number;
  readonly sessionNonce?: () => string;
  readonly sourceProof?: () => SourceProof;
  readonly bunVersion?: string;
}

interface SourceProof {
  readonly root: string;
  readonly commit: string;
  readonly branch: string;
  readonly clean: boolean;
}

interface ServerNamespace {
  readonly session: string | null;
  readonly socket: string;
}

interface DefaultInvariant extends ServerNamespace {
  readonly focusFingerprint: string;
  readonly workspaceCount: number;
}

interface PhaseState {
  readonly target: MuxTarget;
  readonly lastSeq: number;
}

export interface WindowsRestartCycleEvidence {
  readonly cycle: number;
  readonly stopped: true;
  readonly socketApiRejected: true;
  readonly restarted: true;
  readonly server: ServerNamespace;
  readonly before: {
    readonly terminalId: string;
    readonly lastSeq: number;
  };
  readonly after: {
    readonly terminalId: string;
    readonly lastSeq: number;
  };
  readonly marker: string;
  readonly defaultStateFingerprint: string;
  readonly workspaceShapeStable: true;
  readonly terminalGenerationAdvanced: true;
  readonly ledgerSequenceAdvanced: true;
  readonly snapshotShapeRestored: true;
  readonly terminalResponsive: true;
  readonly defaultInvariantStable: true;
}

export interface WindowsRestartQualificationEvidence {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly verdict: "pass" | "fail";
  readonly scope: "native-windows-isolated-herdr-restart-resume";
  readonly completeFiveCycleGate: boolean;
  readonly inputs: {
    readonly platform: string;
    readonly architecture: string;
    readonly binary: { readonly path: string; readonly sha256: string };
    readonly herdr: { readonly path: string; readonly sha256: string };
    readonly source: SourceProof;
    readonly qualifier: { readonly path: string; readonly sha256: string };
    readonly bunVersion: string;
    readonly sid: string;
    readonly herdrSessionPrefix: string;
    readonly herdrSession: string;
    readonly cycles: number;
  };
  readonly initial: {
    readonly target: MuxTarget | null;
    readonly lastSeq: number | null;
    readonly defaultServerSocket: string;
    readonly defaultWorkspaceCount: number;
  };
  readonly cycles: readonly WindowsRestartCycleEvidence[];
  readonly cleanup: {
    readonly terminalCloseConfirmed: boolean;
    readonly namedSessionStopped: boolean;
    readonly namedSessionDeleted: boolean;
    readonly retainedForRecovery: boolean;
    readonly defaultInvariantStable: boolean;
    readonly errors: readonly string[];
  };
  readonly assertions: readonly string[];
  readonly limitations: readonly string[];
  readonly error?: { readonly name: string; readonly message: string };
}

type JsonRecord = Record<string, unknown>;

const defaultRunner: ProcessRunner = async (invocation) => {
  const child = Bun.spawn(
    [invocation.executable, ...invocation.args],
    {
      ...(invocation.env === undefined ? {} : { env: invocation.env }),
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

const defaultStartServer: ServerStarter = (herdr, session) => {
  const env = { ...process.env };
  for (const key of [
    "HERDR_SESSION",
    "HERDR_SOCKET_PATH",
    "HERDR_ENV",
    "HERDR_WORKSPACE_ID",
    "HERDR_TAB_ID",
    "HERDR_PANE_ID",
    "HERDR_TERMINAL_ID",
  ]) {
    delete env[key];
  }
  const child = Bun.spawn([herdr, "--session", session, "server"], {
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
  });
  child.unref();
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, path: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${path} must be a JSON object.`);
  return value;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string.`);
  }
  return value;
}

function absolutePath(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value);
}

function safeError(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: String(error) };
}

function validateSessionPrefix(value: string): void {
  if (
    value === "default" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,30}$/.test(value)
  ) {
    throw new Error(
      "--herdr-session-prefix must be a non-default 1-31 character prefix using letters, numbers, dot, underscore, or hyphen.",
    );
  }
}

function disposableSessionName(prefix: string, nonce: string): string {
  if (!/^[a-f0-9]{32}$/.test(nonce)) {
    throw new Error("The internal Herdr session nonce must be 128-bit lowercase hexadecimal.");
  }
  return `${prefix}-${nonce}`;
}

function executablePath(
  path: string,
  label: string,
  executableExists: (path: string) => boolean,
): string {
  if (!absolutePath(path)) throw new Error(`${label} must be an absolute path.`);
  if ([".bat", ".cmd"].includes(extname(path).toLowerCase())) {
    throw new Error(`${label} must be a native executable, not a shell shim.`);
  }
  if (!executableExists(path)) throw new Error(`${label} does not exist: ${path}`);
  return path;
}

function defaultExecutableExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function defaultSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function defaultSourceProof(): SourceProof {
  const root = resolve(import.meta.dir, "..");
  const git = (args: readonly string[]): string => {
    const result = Bun.spawnSync(
      [
        "git",
        "-c",
        `safe.directory=${root.replaceAll("\\", "/")}`,
        "-c",
        "core.excludesFile=",
        ...args,
      ],
      {
        cwd: root,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Git source proof failed (${result.exitCode}): ${result.stderr.toString().trim() || "no stderr"}`,
      );
    }
    return result.stdout.toString().trim();
  };
  const commit = git(["rev-parse", "HEAD"]);
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error("Git source proof did not return a full lowercase commit SHA.");
  }
  return {
    root,
    commit,
    branch: git(["branch", "--show-current"]),
    clean: git(["status", "--short", "--untracked-files=all"]).length === 0,
  };
}

function defaultWriteEvidence(path: string, evidence: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  try {
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
    rmSync(path, { force: true });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

async function invoke(
  executable: string,
  args: readonly string[],
  runner: ProcessRunner,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<ProcessResult> {
  return runner({
    executable,
    args: [...args],
    shell: false,
    ...(env === undefined ? {} : { env }),
  });
}

async function successful(
  executable: string,
  args: readonly string[],
  runner: ProcessRunner,
  operation: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<ProcessResult> {
  const result = await invoke(executable, args, runner, env);
  if (result.exitCode !== 0) {
    throw new Error(
      `${operation} failed with exit ${result.exitCode}: ${result.stderr.trim() || "no stderr"}`,
    );
  }
  if (result.stderr.trim().length > 0) {
    throw new Error(`${operation} wrote stderr on success: ${result.stderr.trim()}`);
  }
  return result;
}

async function jsonSuccess(
  executable: string,
  args: readonly string[],
  runner: ProcessRunner,
  operation: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<unknown> {
  const result = await successful(executable, args, runner, operation, env);
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch (error) {
    throw new Error(`${operation} did not return valid JSON.`, { cause: error });
  }
}

function parseServer(
  value: unknown,
  expectedSession: string | null,
  operation: string,
): ServerNamespace {
  const payload = record(value, operation);
  const client = record(payload.client, `${operation}.client`);
  const server = record(payload.server, `${operation}.server`);
  if (server.running !== true) throw new Error(`${operation} is not running.`);
  if (client.session !== expectedSession || server.session !== expectedSession) {
    throw new Error(`${operation} resolved the wrong Herdr session.`);
  }
  const socket = requiredString(server.socket, `${operation}.server.socket`);
  if (!absolutePath(socket)) throw new Error(`${operation} socket must be absolute.`);
  if (server.protocol !== 18 || client.protocol !== 18 || server.compatible !== true) {
    throw new Error(`${operation} is not compatible with Herdr protocol 18.`);
  }
  return { session: expectedSession, socket };
}

async function serverStatus(
  herdr: string,
  session: string,
  runner: ProcessRunner,
): Promise<ServerNamespace> {
  return parseServer(
    await jsonSuccess(
      herdr,
      ["--session", session, "status", "--json"],
      runner,
      `Herdr session ${session} status`,
    ),
    session === "default" ? null : session,
    `Herdr session ${session} status`,
  );
}

function sessionRows(value: unknown): readonly JsonRecord[] {
  const rows = record(value, "Herdr session list").sessions;
  if (!Array.isArray(rows)) throw new Error("Herdr session list.sessions must be an array.");
  return rows.map((row, index) => record(row, `Herdr session list.sessions[${index}]`));
}

async function sessions(
  herdr: string,
  runner: ProcessRunner,
): Promise<readonly JsonRecord[]> {
  return sessionRows(
    await jsonSuccess(herdr, ["session", "list", "--json"], runner, "Herdr session list"),
  );
}

function sessionRow(
  rows: readonly JsonRecord[],
  name: string,
): JsonRecord | undefined {
  return rows.find((row) => row.name === name);
}

async function defaultInvariant(
  herdr: string,
  runner: ProcessRunner,
): Promise<DefaultInvariant> {
  const server = await serverStatus(herdr, "default", runner);
  const envelope = record(
    await jsonSuccess(
      herdr,
      ["--session", "default", "api", "snapshot"],
      runner,
      "Default Herdr snapshot",
    ),
    "Default Herdr snapshot",
  );
  const result = record(envelope.result, "Default Herdr snapshot.result");
  const snapshot = record(result.snapshot, "Default Herdr snapshot.result.snapshot");
  if (!Array.isArray(snapshot.workspaces)) {
    throw new Error("Default Herdr snapshot workspaces must be an array.");
  }
  const workspaceIds = snapshot.workspaces.map((value, index) =>
    requiredString(
      record(value, `Default Herdr workspace ${index}`).workspace_id,
      `Default Herdr workspace ${index}.workspace_id`,
    )
  ).sort();
  if (!Array.isArray(snapshot.tabs) || !Array.isArray(snapshot.panes)) {
    throw new Error("Default Herdr snapshot tabs and panes must be arrays.");
  }
  const tabIds = snapshot.tabs.map((value, index) =>
    requiredString(
      record(value, `Default Herdr tab ${index}`).tab_id,
      `Default Herdr tab ${index}.tab_id`,
    )
  ).sort();
  const paneIds = snapshot.panes.map((value, index) => {
    const pane = record(value, `Default Herdr pane ${index}`);
    return {
      paneId: requiredString(pane.pane_id, `Default Herdr pane ${index}.pane_id`),
      terminalId: requiredString(
        pane.terminal_id,
        `Default Herdr pane ${index}.terminal_id`,
      ),
    };
  }).sort((left, right) => left.paneId.localeCompare(right.paneId));
  const focused = {
    workspaceId: snapshot.focused_workspace_id,
    tabId: snapshot.focused_tab_id,
    paneId: snapshot.focused_pane_id,
  };
  for (const [name, value] of Object.entries(focused)) {
    if (value !== null && typeof value !== "string") {
      throw new Error(`Default Herdr focused ${name} must be a string or null.`);
    }
  }
  const focusFingerprint = createHash("sha256")
    .update(JSON.stringify({ focused, workspaceIds, tabIds, paneIds }))
    .digest("hex");
  return {
    ...server,
    focusFingerprint,
    workspaceCount: workspaceIds.length,
  };
}

function assertDefaultInvariant(
  expected: DefaultInvariant,
  actual: DefaultInvariant,
): void {
  if (
    expected.session !== actual.session ||
    expected.socket !== actual.socket ||
    expected.focusFingerprint !== actual.focusFingerprint ||
    expected.workspaceCount !== actual.workspaceCount
  ) {
    throw new Error("The default Herdr server or operator focus changed during isolated qualification.");
  }
}

function phaseState(evidence: WindowsMuxQualificationEvidence): PhaseState {
  const status = record(
    evidence.observations.idempotentStatus,
    "Windows mux qualification idempotentStatus",
  );
  const lastSeq = status.lastSeq;
  if (!Number.isSafeInteger(lastSeq) || (lastSeq as number) < 0) {
    throw new Error("Windows mux qualification lastSeq is invalid.");
  }
  const target = record(status.target, "Windows mux qualification target");
  if (target.version !== 2 || target.backend !== "herdr") {
    throw new Error("Windows mux qualification did not return a V2 Herdr target.");
  }
  return { target: target as unknown as MuxTarget, lastSeq: lastSeq as number };
}

function assertFreshInitialPhase(
  evidence: WindowsMuxQualificationEvidence,
): void {
  const preflight = record(
    evidence.observations.preflightStatus,
    "Initial Windows mux qualification preflightStatus",
  );
  const preflightMux = record(
    preflight.muxStatus,
    "Initial Windows mux qualification preflightStatus.muxStatus",
  );
  if (
    preflight.dispatchLifecycle !== "created" ||
    preflight.target !== null ||
    preflightMux.state !== "not_recorded"
  ) {
    throw new Error(
      "Restart qualification requires a fresh created/not_recorded Dispatch terminal session.",
    );
  }
  const opened = record(
    evidence.observations.open,
    "Initial Windows mux qualification open",
  );
  if (
    opened.disposition !== "created" ||
    opened.receipt !== "recorded" ||
    opened.recovery !== null
  ) {
    throw new Error(
      "Restart qualification initial open did not create and record a fresh target.",
    );
  }
}

function restoredGeneration(previous: MuxTarget, next: MuxTarget): boolean {
  return (
    previous.version === next.version &&
    previous.backend === next.backend &&
    previous.protocol === next.protocol &&
    previous.server.session === next.server.session &&
    previous.server.socket === next.server.socket &&
    previous.workspaceId === next.workspaceId &&
    previous.tabId === next.tabId &&
    previous.paneId === next.paneId &&
    previous.terminalId !== next.terminalId &&
    previous.canonicalCwd === next.canonicalCwd
  );
}

async function reconcileRestoredOpen(
  binary: string,
  herdr: string,
  session: string,
  sid: string,
  runner: ProcessRunner,
): Promise<void> {
  const result = await runner({
    executable: binary,
    args: ["open", sid, "--recover-restored-terminal", "--json"],
    shell: false,
    env: {
      ...process.env,
      DISPATCH_HERDR_BIN: herdr,
      DISPATCH_HERDR_SESSION: session,
    },
  });
  if (result.exitCode !== 0 || result.stderr.trim().length > 0) {
    throw new Error(
      `Dispatch restored-generation open failed with exit ${result.exitCode}: ${result.stderr.trim() || "no stderr"}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout) as unknown;
  } catch (error) {
    throw new Error("Dispatch restored-generation open did not return JSON.", {
      cause: error,
    });
  }
  const opened = record(value, "Dispatch restored-generation open");
  if (
    opened.disposition !== "recovered" ||
    opened.receipt !== "recorded" ||
    opened.recovery !== "restored_terminal"
  ) {
    throw new Error(
      "Dispatch did not durably record an explicitly authorized restored-terminal transition before reuse.",
    );
  }
  if (!Array.isArray(opened.projectionWarnings) || opened.projectionWarnings.length > 0) {
    throw new Error("Dispatch restored-generation open reported projection warnings.");
  }
}

async function closeDispatchTerminal(
  binary: string,
  herdr: string,
  session: string,
  sid: string,
  expectedServer: ServerNamespace,
  runner: ProcessRunner,
  allowRestoredGeneration: boolean,
): Promise<void> {
  const value = await jsonSuccess(
    binary,
    [
      "close",
      sid,
      ...(allowRestoredGeneration
        ? ["--recover-restored-terminal"]
        : []),
      "--json",
    ],
    runner,
    "Dispatch terminal cleanup",
    {
      ...process.env,
      DISPATCH_HERDR_BIN: herdr,
      DISPATCH_HERDR_SESSION: session,
    },
  );
  const closed = record(value, "Dispatch terminal cleanup");
  if (closed.sid !== sid) {
    throw new Error("Dispatch terminal cleanup returned the wrong session ID.");
  }
  if (
    !["recorded", "already_recorded", "recovered_after_append"].includes(
      String(closed.receipt),
    )
  ) {
    throw new Error("Dispatch terminal cleanup did not confirm a durable close receipt.");
  }
  if (
    !Array.isArray(closed.projectionWarnings) ||
    closed.projectionWarnings.length > 0
  ) {
    throw new Error("Dispatch terminal cleanup reported projection warnings.");
  }

  if (closed.target === null) {
    if (closed.muxOutcome !== "not_found") {
      throw new Error(
        "Dispatch terminal cleanup returned no target without a not_found outcome.",
      );
    }
    return;
  }

  const target = record(closed.target, "Dispatch terminal cleanup.target");
  const server = record(
    target.server,
    "Dispatch terminal cleanup.target.server",
  );
  if (
    target.version !== 2 ||
    target.backend !== "herdr" ||
    server.session !== expectedServer.session ||
    server.socket !== expectedServer.socket
  ) {
    throw new Error(
      "Dispatch terminal cleanup target did not match the owned Herdr namespace.",
    );
  }
  if (!["closed", "already_absent"].includes(String(closed.muxOutcome))) {
    throw new Error(
      "Dispatch terminal cleanup did not confirm the target absent or closed.",
    );
  }
}

async function waitForServer(
  herdr: string,
  session: string,
  runner: ProcessRunner,
  sleep: (milliseconds: number) => Promise<void>,
  attempts: number,
): Promise<ServerNamespace> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await serverStatus(herdr, session, runner);
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }
  throw new Error(`Named Herdr server ${session} did not become ready.`, {
    cause: lastError,
  });
}

async function startNamed(
  herdr: string,
  session: string,
  runner: ProcessRunner,
  starter: ServerStarter,
  sleep: (milliseconds: number) => Promise<void>,
  attempts: number,
): Promise<ServerNamespace> {
  await starter(herdr, session);
  const server = await waitForServer(herdr, session, runner, sleep, attempts);
  const row = sessionRow(await sessions(herdr, runner), session);
  if (!row || row.running !== true) {
    throw new Error(`Named Herdr session ${session} was not listed as running.`);
  }
  return server;
}

async function stopNamed(
  herdr: string,
  session: string,
  runner: ProcessRunner,
): Promise<void> {
  await successful(
    herdr,
    ["--session", session, "server", "stop"],
    runner,
    `Stop Herdr session ${session}`,
  );
  const row = sessionRow(await sessions(herdr, runner), session);
  if (!row || row.running !== false) {
    throw new Error(`Stopped Herdr session ${session} was not listed as stopped.`);
  }
}

async function assertNamedSocketApiRejected(
  herdr: string,
  session: string,
  runner: ProcessRunner,
): Promise<void> {
  const result = await invoke(
    herdr,
    ["--session", session, "api", "snapshot"],
    runner,
  );
  if (result.exitCode === 0) {
    throw new Error(`Stopped Herdr session ${session} still accepted socket API requests.`);
  }
}

async function deleteNamed(
  herdr: string,
  session: string,
  runner: ProcessRunner,
): Promise<void> {
  const response = record(
    await jsonSuccess(
      herdr,
      ["session", "delete", session, "--json"],
      runner,
      `Delete Herdr session ${session}`,
    ),
    `Delete Herdr session ${session}`,
  );
  if (response.deleted !== true) throw new Error(`Herdr session ${session} was not deleted.`);
  if (sessionRow(await sessions(herdr, runner), session)) {
    throw new Error(`Deleted Herdr session ${session} remains listed.`);
  }
}

async function emitMarker(
  herdr: string,
  session: string,
  paneId: string,
  marker: string,
  runner: ProcessRunner,
): Promise<void> {
  await successful(
    herdr,
    [
      "--session",
      session,
      "pane",
      "run",
      paneId,
      `cmd.exe /d /c echo ${marker}`,
    ],
    runner,
    `Emit terminal marker ${marker}`,
  );
  await successful(
    herdr,
    [
      "--session",
      session,
      "pane",
      "wait-output",
      paneId,
      "--match",
      marker,
      "--source",
      "recent-unwrapped",
      "--lines",
      "200",
      "--timeout",
      "5000",
    ],
    runner,
    `Observe terminal marker ${marker}`,
  );
}

export function parseWindowsRestartQualificationOptions(
  args: readonly string[],
): WindowsRestartQualificationOptions {
  const values = new Map<string, string>();
  const options = new Set([
    "--binary",
    "--sid",
    "--herdr-session-prefix",
    "--cycles",
    "--output",
    "--herdr",
  ]);
  for (let position = 0; position < args.length; position += 1) {
    const option = args[position]!;
    if (!options.has(option)) throw new Error(`Unknown option: ${option}`);
    if (values.has(option)) throw new Error(`Option may be supplied only once: ${option}`);
    const value = args[position + 1];
    if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
    values.set(option, value);
    position += 1;
  }
  const binary = values.get("--binary");
  const sid = values.get("--sid");
  const herdrSessionPrefix = values.get("--herdr-session-prefix");
  if (!binary) throw new Error("--binary is required.");
  if (!sid || !isSortableId(sid)) throw new Error("--sid must be a canonical Dispatch session ID.");
  if (!herdrSessionPrefix) {
    throw new Error("--herdr-session-prefix is required.");
  }
  validateSessionPrefix(herdrSessionPrefix);
  const cyclesValue = values.get("--cycles");
  const cycles = cyclesValue === undefined ? undefined : Number(cyclesValue);
  if (
    cycles !== undefined &&
    (!Number.isSafeInteger(cycles) || cycles < 1 || cycles > 20)
  ) {
    throw new Error("--cycles must be an integer from 1 through 20.");
  }
  const output = values.get("--output");
  const herdr = values.get("--herdr");
  return {
    binary: resolve(binary),
    sid,
    herdrSessionPrefix,
    ...(cycles === undefined ? {} : { cycles }),
    ...(output === undefined ? {} : { output: resolve(output) }),
    ...(herdr === undefined ? {} : { herdr: resolve(herdr) }),
  };
}

export async function qualifyWindowsRestart(
  options: WindowsRestartQualificationOptions,
  dependencies: WindowsRestartQualificationDependencies = {},
): Promise<WindowsRestartQualificationEvidence> {
  const platform = dependencies.platform ?? process.platform;
  const architecture = dependencies.architecture ?? process.arch;
  if (platform !== "win32" || architecture !== "x64") {
    throw new Error(
      `Windows restart qualification requires native win32/x64, received ${platform}/${architecture}.`,
    );
  }
  if (!isSortableId(options.sid)) throw new Error("SID must be a canonical Dispatch session ID.");
  validateSessionPrefix(options.herdrSessionPrefix);
  const sessionNonce = (dependencies.sessionNonce ?? (() =>
    randomBytes(16).toString("hex")))();
  const herdrSession = disposableSessionName(
    options.herdrSessionPrefix,
    sessionNonce,
  );
  const cyclesRequested = options.cycles ?? 5;
  if (
    !Number.isSafeInteger(cyclesRequested) ||
    cyclesRequested < 1 ||
    cyclesRequested > 20
  ) {
    throw new Error("Restart cycles must be an integer from 1 through 20.");
  }

  const runner = dependencies.runner ?? defaultRunner;
  const starter = dependencies.startServer ?? defaultStartServer;
  const sleep = dependencies.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
  const executableExists = dependencies.executableExists ?? defaultExecutableExists;
  const binary = executablePath(options.binary, "--binary", executableExists);
  const locatedHerdr = options.herdr ?? (dependencies.which ?? Bun.which)("herdr");
  if (!locatedHerdr) throw new Error("Herdr was not found on PATH; pass --herdr explicitly.");
  const herdr = executablePath(locatedHerdr, "Herdr executable", executableExists);
  if (
    options.output &&
    [binary, herdr].some((path) => path.toLowerCase() === options.output!.toLowerCase())
  ) {
    throw new Error("--output must not overwrite the Dispatch or Herdr executable.");
  }
  const hash = dependencies.sha256 ?? defaultSha256;
  const binarySha256 = hash(binary);
  const herdrSha256 = hash(herdr);
  const sourceProof = dependencies.sourceProof ?? defaultSourceProof;
  const source = sourceProof();
  if (!source.clean) {
    throw new Error(
      "Windows restart qualification requires a clean Git source tree.",
    );
  }
  const qualifierPath = resolve(
    import.meta.dir,
    "qualify-windows-restart.ts",
  );
  const qualifierSha256 = hash(qualifierPath);
  const bunVersion = dependencies.bunVersion ?? Bun.version;
  if (bunVersion !== "1.3.14") {
    throw new Error(
      `Windows restart qualification requires Bun 1.3.14, received ${bunVersion}.`,
    );
  }
  if (options.output) {
    const outputRelative = relative(source.root, options.output);
    if (
      outputRelative.length === 0 ||
      (!outputRelative.startsWith("..") && !isAbsolute(outputRelative))
    ) {
      throw new Error(
        "--output must be outside the qualified clean source tree.",
      );
    }
  }
  const readinessAttempts = dependencies.readinessAttempts ?? 100;
  const cycleEvidence: WindowsRestartCycleEvidence[] = [];
  const assertions: string[] = [];
  const cleanupErrors: string[] = [];
  let baselineDefault: DefaultInvariant | undefined;
  let baselinePhase: PhaseState | undefined;
  let currentPhase: PhaseState | undefined;
  let failure: unknown;
  let terminalCloseConfirmed = false;
  let namedSessionStopped = false;
  let namedSessionDeleted = false;
  let retainedForRecovery = false;
  let defaultStable = false;
  let ownedNamedSession = false;
  let restoredRecoveryPending = false;

  const phaseDependencies = {
    runner,
    platform,
    architecture,
    which: () => herdr,
    executableExists,
    sha256: hash,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  };
  const phaseOptions = {
    binary,
    herdr,
    herdrSession,
    sid: options.sid,
    exerciseExternalClose: false,
  } as const;

  try {
    const initialRows = await sessions(herdr, runner);
    const defaultRow = sessionRow(initialRows, "default");
    if (!defaultRow || defaultRow.running !== true) {
      throw new Error("The default Herdr session must already be running.");
    }
    if (sessionRow(initialRows, herdrSession)) {
      throw new Error(
        `Internally named Herdr session ${herdrSession} already exists; refusing to claim or mutate it.`,
      );
    }
    baselineDefault = await defaultInvariant(herdr, runner);
    ownedNamedSession = true;
    await startNamed(
      herdr,
      herdrSession,
      runner,
      starter,
      sleep,
      readinessAttempts,
    );
    assertions.push(
      "the disposable Herdr session used an internally generated 128-bit nonce and was absent before start",
    );

    const initialQualification = await qualifyWindowsMux(
      { ...phaseOptions, close: false },
      phaseDependencies,
    );
    assertFreshInitialPhase(initialQualification);
    baselinePhase = phaseState(initialQualification);
    currentPhase = baselinePhase;
    if (baselinePhase.target.server.session !== herdrSession) {
      throw new Error("Initial Dispatch target was not bound to the isolated named Herdr session.");
    }
    assertions.push("fresh Dispatch open is bound to the explicit isolated Herdr namespace");

    for (let cycle = 1; cycle <= cyclesRequested; cycle += 1) {
      if (!currentPhase) {
        throw new Error("Restart qualification lost its current target phase.");
      }
      const before = currentPhase;
      const afterMarker = `DISPATCH_RESTART_${cycle}_AFTER`;
      await stopNamed(herdr, herdrSession, runner);
      namedSessionStopped = true;
      await assertNamedSocketApiRejected(herdr, herdrSession, runner);
      assertDefaultInvariant(
        baselineDefault,
        await defaultInvariant(herdr, runner),
      );

      await startNamed(
        herdr,
        herdrSession,
        runner,
        starter,
        sleep,
        readinessAttempts,
      );
      namedSessionStopped = false;
      restoredRecoveryPending = true;
      await reconcileRestoredOpen(
        binary,
        herdr,
        herdrSession,
        options.sid,
        runner,
      );
      restoredRecoveryPending = false;
      const resumedQualification = await qualifyWindowsMux(
        { ...phaseOptions, close: false },
        phaseDependencies,
      );
      const resumed = phaseState(resumedQualification);
      if (!restoredGeneration(before.target, resumed.target)) {
        throw new Error(
          `Restart cycle ${cycle} did not produce exactly one restored terminal generation within the persisted workspace shape.`,
        );
      }
      if (resumed.lastSeq !== before.lastSeq + 1) {
        throw new Error(
          `Restart cycle ${cycle} did not append exactly one restored-generation receipt.`,
        );
      }
      await emitMarker(
        herdr,
        herdrSession,
        resumed.target.paneId,
        afterMarker,
        runner,
      );
      assertDefaultInvariant(
        baselineDefault,
        await defaultInvariant(herdr, runner),
      );
      cycleEvidence.push({
        cycle,
        stopped: true,
        socketApiRejected: true,
        restarted: true,
        server: resumed.target.server,
        before: {
          terminalId: before.target.terminalId,
          lastSeq: before.lastSeq,
        },
        after: {
          terminalId: resumed.target.terminalId,
          lastSeq: resumed.lastSeq,
        },
        marker: afterMarker,
        defaultStateFingerprint: baselineDefault.focusFingerprint,
        workspaceShapeStable: true,
        terminalGenerationAdvanced: true,
        ledgerSequenceAdvanced: true,
        snapshotShapeRestored: true,
        terminalResponsive: true,
        defaultInvariantStable: true,
      });
      currentPhase = resumed;
    }
    assertions.push(`${cyclesRequested} named-server stop/start cycles preserved workspace shape and recorded one new terminal generation each`);
    assertions.push("snapshot-restored panes executed a fresh command after every restart");
    assertions.push(
      "the default server namespace, workspace set, and operator focus matched the baseline at every qualification checkpoint",
    );

    await qualifyWindowsMux(
      { ...phaseOptions, close: true },
      phaseDependencies,
    );
    terminalCloseConfirmed = true;
    await stopNamed(herdr, herdrSession, runner);
    namedSessionStopped = true;
    await deleteNamed(herdr, herdrSession, runner);
    namedSessionDeleted = true;
    assertDefaultInvariant(
      baselineDefault,
      await defaultInvariant(herdr, runner),
    );
    defaultStable = true;
  } catch (error) {
    failure = error;
  } finally {
    try {
      if (!ownedNamedSession) {
        if (baselineDefault) {
          assertDefaultInvariant(
            baselineDefault,
            await defaultInvariant(herdr, runner),
          );
          defaultStable = true;
        }
      } else {
      const rows = await sessions(herdr, runner);
      const named = sessionRow(rows, herdrSession);
      if (named && named.running === true && !terminalCloseConfirmed) {
        try {
          const cleanupServer = await serverStatus(
            herdr,
            herdrSession,
            runner,
          );
          await closeDispatchTerminal(
            binary,
            herdr,
            herdrSession,
            options.sid,
            cleanupServer,
            runner,
            restoredRecoveryPending,
          );
          terminalCloseConfirmed = true;
        } catch (error) {
          cleanupErrors.push(`terminal close: ${safeError(error).message}`);
        }
      }
      const refreshed = sessionRow(await sessions(herdr, runner), herdrSession);
      if (refreshed?.running === true) {
        try {
          await stopNamed(herdr, herdrSession, runner);
          namedSessionStopped = true;
        } catch (error) {
          cleanupErrors.push(`named stop: ${safeError(error).message}`);
        }
      }
      const stopped = sessionRow(await sessions(herdr, runner), herdrSession);
      if (stopped && terminalCloseConfirmed) {
        try {
          await deleteNamed(herdr, herdrSession, runner);
          namedSessionDeleted = true;
        } catch (error) {
          cleanupErrors.push(`named delete: ${safeError(error).message}`);
        }
      } else if (stopped) {
        retainedForRecovery = true;
      }
      }
    } catch (error) {
      cleanupErrors.push(`session cleanup inspection: ${safeError(error).message}`);
    }
    if (baselineDefault) {
      try {
        assertDefaultInvariant(
          baselineDefault,
          await defaultInvariant(herdr, runner),
        );
        defaultStable = true;
      } catch (error) {
        cleanupErrors.push(`default invariant: ${safeError(error).message}`);
      }
    }
  }

  if (failure === undefined && cleanupErrors.length > 0) {
    failure = new Error(cleanupErrors.join("; "));
  }
  if (
    failure === undefined &&
    (hash(binary) !== binarySha256 ||
      hash(herdr) !== herdrSha256 ||
      hash(qualifierPath) !== qualifierSha256)
  ) {
    failure = new Error(
      "The Dispatch, Herdr, or qualifier executable/source changed during restart qualification.",
    );
  } else if (failure === undefined) {
    const finalSource = sourceProof();
    if (
      !finalSource.clean ||
      finalSource.root !== source.root ||
      finalSource.commit !== source.commit ||
      finalSource.branch !== source.branch
    ) {
      failure = new Error(
        "The qualified Git source state changed during restart qualification.",
      );
    } else {
      assertions.push(
        "Dispatch, Herdr, qualifier, Bun runtime, and clean Git source identity remained stable",
      );
    }
  }

  const evidence: WindowsRestartQualificationEvidence = {
    schemaVersion: 1,
    generatedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    verdict: failure === undefined ? "pass" : "fail",
    scope: "native-windows-isolated-herdr-restart-resume",
    completeFiveCycleGate:
      failure === undefined &&
      cyclesRequested >= 5 &&
      cycleEvidence.length === cyclesRequested &&
      terminalCloseConfirmed &&
      namedSessionDeleted &&
      defaultStable,
    inputs: {
      platform,
      architecture,
      binary: { path: binary, sha256: binarySha256 },
      herdr: { path: herdr, sha256: herdrSha256 },
      source,
      qualifier: { path: qualifierPath, sha256: qualifierSha256 },
      bunVersion,
      sid: options.sid,
      herdrSessionPrefix: options.herdrSessionPrefix,
      herdrSession,
      cycles: cyclesRequested,
    },
    initial: {
      target: baselinePhase?.target ?? null,
      lastSeq: baselinePhase?.lastSeq ?? null,
      defaultServerSocket: baselineDefault?.socket ?? "not_observed",
      defaultWorkspaceCount: baselineDefault?.workspaceCount ?? 0,
    },
    cycles: cycleEvidence,
    cleanup: {
      terminalCloseConfirmed,
      namedSessionStopped,
      namedSessionDeleted,
      retainedForRecovery,
      defaultInvariantStable: defaultStable,
      errors: cleanupErrors,
    },
    assertions,
    limitations: [
      "The receipt proves Herdr namespace, restored workspace/tab/pane shape, cwd continuity, a durably recorded new terminal generation, and post-restart command responsiveness; Herdr cold restart intentionally replaces the original pane processes.",
      "Pane screen-history replay is not required or enabled because it is off by default and can persist secrets, prompts, tokens, and command output.",
      "Herdr exposes a stable session socket but no server-incarnation token, so a state-resetting restart with adversarial ID reuse cannot be cryptographically excluded.",
      "Herdr focus and close mutations accept workspace IDs rather than a conditional full-target generation token, leaving a bounded preflight-to-mutation race.",
      "Herdr exposes no server-process ownership token; the qualifier uses an internally generated 128-bit session-name nonce, making accidental concurrent collision negligible but not cryptographically authenticating the serving process against an adversarial local actor.",
    ],
    ...(failure === undefined ? {} : { error: safeError(failure) }),
  };

  if (options.output) {
    (dependencies.writeEvidence ?? defaultWriteEvidence)(options.output, evidence);
  }
  if (failure !== undefined) {
    throw new Error(
      `Windows restart qualification failed: ${safeError(failure).message}${options.output ? `; evidence: ${options.output}` : ""}`,
      { cause: failure },
    );
  }
  return evidence;
}

if (import.meta.main) {
  const evidence = await qualifyWindowsRestart(
    parseWindowsRestartQualificationOptions(process.argv.slice(2)),
  );
  console.log(JSON.stringify(evidence, null, 2));
}
