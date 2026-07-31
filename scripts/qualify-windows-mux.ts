import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, resolve, win32 } from "node:path";

import { isSortableId } from "../src/core/identity";

export interface WindowsMuxQualificationOptions {
  readonly binary: string;
  readonly sid: string;
  readonly exerciseExternalClose: boolean;
  readonly close: boolean;
  readonly output?: string;
  readonly herdr?: string;
}

export interface ProcessInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly shell: false;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type ProcessRunner = (
  invocation: ProcessInvocation,
) => Promise<ProcessResult>;

interface MuxTarget {
  readonly version: 1;
  readonly backend: "herdr";
  readonly protocol: number;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly paneId: string;
  readonly terminalId: string;
  readonly canonicalCwd: string;
}

interface DspStatus {
  readonly sid: string;
  readonly dispatchLifecycle: "created" | "opened" | "closed" | "removed";
  readonly lastSeq: number;
  readonly target: MuxTarget | null;
  readonly muxStatus:
    | { readonly state: "not_recorded" }
    | { readonly state: "absent"; readonly target: MuxTarget }
    | {
        readonly state: "running";
        readonly target: MuxTarget;
        readonly focused: boolean;
        readonly agentStatus?: string;
      };
}

interface DspOpen {
  readonly sid: string;
  readonly target: MuxTarget;
  readonly disposition: "created" | "recovered";
  readonly receipt: "recorded" | "already_recorded" | "recovered_after_append";
  readonly muxStatus: Extract<DspStatus["muxStatus"], { readonly state: "running" }>;
  readonly projectionWarnings: readonly string[];
}

interface DspClose {
  readonly sid: string;
  readonly target: MuxTarget | null;
  readonly muxOutcome: "closed" | "already_absent" | "not_found";
  readonly alreadyClosed: boolean;
  readonly receipt: "recorded" | "already_recorded" | "recovered_after_append";
  readonly projectionWarnings: readonly string[];
}

interface FocusSnapshot {
  readonly focusedWorkspaceId: string | null;
  readonly workspaceIds: readonly string[];
}

export type WindowsMuxQualificationProfile =
  | "open_status"
  | "external_recovery"
  | "terminal_close"
  | "full_lifecycle";

export interface WindowsMuxQualificationEvidence {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly verdict: "pass" | "fail";
  readonly scope: "native-windows-existing-dispatch-session";
  readonly profile: WindowsMuxQualificationProfile;
  readonly completeLifecycle: boolean;
  readonly inputs: {
    readonly platform: string;
    readonly architecture: string;
    readonly binary: { readonly path: string; readonly sha256: string };
    readonly herdr: { readonly path: string; readonly sha256: string };
    readonly sid: string;
    readonly exerciseExternalClose: boolean;
    readonly terminalCloseRequested: boolean;
  };
  readonly assertions: readonly string[];
  readonly observations: Readonly<Record<string, unknown>>;
  readonly focusRestoration: Readonly<Record<string, unknown>>;
  readonly error?: { readonly name: string; readonly message: string };
}

export interface QualificationDependencies {
  readonly runner?: ProcessRunner;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly which?: (executable: string) => string | null;
  readonly executableExists?: (path: string) => boolean;
  readonly sha256?: (path: string) => string;
  readonly now?: () => Date;
  readonly writeEvidence?: (path: string, evidence: unknown) => void;
}

type JsonRecord = Record<string, unknown>;

const TARGET_KEYS = [
  "version",
  "backend",
  "protocol",
  "workspaceId",
  "tabId",
  "paneId",
  "terminalId",
  "canonicalCwd",
] as const;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, path: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${path} must be a JSON object.`);
  return value;
}

function exactKeys(
  value: JsonRecord,
  allowed: readonly string[],
  path: string,
): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new Error(`${path} contains unexpected fields: ${unexpected.join(", ")}.`);
  }
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string.`);
  }
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean.`);
  return value;
}

function integer(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${path} must be a non-negative safe integer.`);
  }
  return value as number;
}

function stringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${path} must be an array of strings.`);
  }
  return value as readonly string[];
}

function enumeration<const T extends readonly string[]>(
  value: unknown,
  choices: T,
  path: string,
): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) {
    throw new Error(`${path} must be one of: ${choices.join(", ")}.`);
  }
  return value as T[number];
}

function absolutePath(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value);
}

function pathIdentity(value: string): string {
  return win32.isAbsolute(value)
    ? win32.normalize(value).toLowerCase()
    : resolve(value);
}

function target(value: unknown, path: string): MuxTarget {
  const item = record(value, path);
  exactKeys(item, TARGET_KEYS, path);
  if (item.version !== 1 || item.backend !== "herdr") {
    throw new Error(`${path} has an unsupported target envelope.`);
  }
  const protocol = integer(item.protocol, `${path}.protocol`);
  if (protocol !== 18) throw new Error(`${path}.protocol must equal 18.`);
  const canonicalCwd = string(item.canonicalCwd, `${path}.canonicalCwd`);
  if (!absolutePath(canonicalCwd)) {
    throw new Error(`${path}.canonicalCwd must be absolute.`);
  }
  return {
    version: 1,
    backend: "herdr",
    protocol,
    workspaceId: string(item.workspaceId, `${path}.workspaceId`),
    tabId: string(item.tabId, `${path}.tabId`),
    paneId: string(item.paneId, `${path}.paneId`),
    terminalId: string(item.terminalId, `${path}.terminalId`),
    canonicalCwd,
  };
}

function nullableTarget(value: unknown, path: string): MuxTarget | null {
  return value === null ? null : target(value, path);
}

function muxStatus(value: unknown, path: string): DspStatus["muxStatus"] {
  const item = record(value, path);
  const state = enumeration(
    item.state,
    ["not_recorded", "absent", "running"] as const,
    `${path}.state`,
  );
  if (state === "not_recorded") {
    exactKeys(item, ["state"], path);
    return { state };
  }
  if (state === "absent") {
    exactKeys(item, ["state", "target"], path);
    return { state, target: target(item.target, `${path}.target`) };
  }
  exactKeys(item, ["state", "target", "focused", "agentStatus"], path);
  const agentStatus = item.agentStatus;
  return {
    state,
    target: target(item.target, `${path}.target`),
    focused: boolean(item.focused, `${path}.focused`),
    ...(agentStatus === undefined
      ? {}
      : { agentStatus: string(agentStatus, `${path}.agentStatus`) }),
  };
}

function statusResult(value: unknown, expectedSid: string): DspStatus {
  const item = record(value, "dsp status");
  exactKeys(
    item,
    ["sid", "dispatchLifecycle", "lastSeq", "target", "muxStatus"],
    "dsp status",
  );
  const sid = string(item.sid, "dsp status.sid");
  if (sid !== expectedSid) throw new Error(`dsp status returned SID ${sid}, expected ${expectedSid}.`);
  return {
    sid,
    dispatchLifecycle: enumeration(
      item.dispatchLifecycle,
      ["created", "opened", "closed", "removed"] as const,
      "dsp status.dispatchLifecycle",
    ),
    lastSeq: integer(item.lastSeq, "dsp status.lastSeq"),
    target: nullableTarget(item.target, "dsp status.target"),
    muxStatus: muxStatus(item.muxStatus, "dsp status.muxStatus"),
  };
}

function openResult(value: unknown, expectedSid: string): DspOpen {
  const item = record(value, "dsp open");
  exactKeys(
    item,
    ["sid", "target", "disposition", "receipt", "muxStatus", "projectionWarnings"],
    "dsp open",
  );
  const sid = string(item.sid, "dsp open.sid");
  if (sid !== expectedSid) throw new Error(`dsp open returned SID ${sid}, expected ${expectedSid}.`);
  const status = muxStatus(item.muxStatus, "dsp open.muxStatus");
  if (status.state !== "running") throw new Error("dsp open did not confirm a running mux target.");
  return {
    sid,
    target: target(item.target, "dsp open.target"),
    disposition: enumeration(
      item.disposition,
      ["created", "recovered"] as const,
      "dsp open.disposition",
    ),
    receipt: enumeration(
      item.receipt,
      ["recorded", "already_recorded", "recovered_after_append"] as const,
      "dsp open.receipt",
    ),
    muxStatus: status,
    projectionWarnings: stringArray(
      item.projectionWarnings,
      "dsp open.projectionWarnings",
    ),
  };
}

function closeResult(value: unknown, expectedSid: string): DspClose {
  const item = record(value, "dsp close");
  exactKeys(
    item,
    ["sid", "target", "muxOutcome", "alreadyClosed", "receipt", "projectionWarnings"],
    "dsp close",
  );
  const sid = string(item.sid, "dsp close.sid");
  if (sid !== expectedSid) throw new Error(`dsp close returned SID ${sid}, expected ${expectedSid}.`);
  return {
    sid,
    target: nullableTarget(item.target, "dsp close.target"),
    muxOutcome: enumeration(
      item.muxOutcome,
      ["closed", "already_absent", "not_found"] as const,
      "dsp close.muxOutcome",
    ),
    alreadyClosed: boolean(item.alreadyClosed, "dsp close.alreadyClosed"),
    receipt: enumeration(
      item.receipt,
      ["recorded", "already_recorded", "recovered_after_append"] as const,
      "dsp close.receipt",
    ),
    projectionWarnings: stringArray(
      item.projectionWarnings,
      "dsp close.projectionWarnings",
    ),
  };
}

function doctorResult(value: unknown): JsonRecord {
  const item = record(value, "dsp doctor");
  exactKeys(item, ["readyForStage0", "readyForStage1", "checks"], "dsp doctor");
  boolean(item.readyForStage0, "dsp doctor.readyForStage0");
  if (!boolean(item.readyForStage1, "dsp doctor.readyForStage1")) {
    throw new Error("Compiled doctor did not qualify Stage 1.");
  }
  if (!Array.isArray(item.checks)) throw new Error("dsp doctor.checks must be an array.");
  for (const [position, checkValue] of item.checks.entries()) {
    const check = record(checkValue, `dsp doctor.checks[${position}]`);
    exactKeys(check, ["name", "status", "detail"], `dsp doctor.checks[${position}]`);
    string(check.name, `dsp doctor.checks[${position}].name`);
    enumeration(
      check.status,
      ["ok", "warn", "fail"] as const,
      `dsp doctor.checks[${position}].status`,
    );
    string(check.detail, `dsp doctor.checks[${position}].detail`);
  }
  return item;
}

function focusSnapshot(value: unknown): FocusSnapshot {
  const envelope = record(value, "herdr snapshot");
  const result = record(envelope.result, "herdr snapshot.result");
  if (result.type !== "session_snapshot") {
    throw new Error("Herdr snapshot result.type must be session_snapshot.");
  }
  const snapshot = record(result.snapshot, "herdr snapshot.result.snapshot");
  const focused = snapshot.focused_workspace_id;
  if (focused !== null && typeof focused !== "string") {
    throw new Error("Herdr focused_workspace_id must be a string or null.");
  }
  if (!Array.isArray(snapshot.workspaces)) {
    throw new Error("Herdr snapshot.workspaces must be an array.");
  }
  const workspaceIds = snapshot.workspaces.map((workspace, position) =>
    string(
      record(workspace, `Herdr snapshot.workspaces[${position}]`).workspace_id,
      `Herdr snapshot.workspaces[${position}].workspace_id`,
    )
  );
  if (focused !== null && !workspaceIds.includes(focused)) {
    throw new Error("Herdr focused workspace is absent from the workspace snapshot.");
  }
  return { focusedWorkspaceId: focused, workspaceIds };
}

function herdrMutation(value: unknown, expectedType: string, operation: string): JsonRecord {
  const envelope = record(value, operation);
  const result = record(envelope.result, `${operation}.result`);
  if (result.type !== expectedType) {
    throw new Error(`${operation}.result.type must be ${expectedType}.`);
  }
  return envelope;
}

function sameTarget(left: MuxTarget, right: MuxTarget): boolean {
  return TARGET_KEYS.every((key) => left[key] === right[key]);
}

function assertSameTarget(left: MuxTarget, right: MuxTarget, context: string): void {
  if (!sameTarget(left, right)) throw new Error(`${context} changed the structured mux target.`);
}

function assertRunningStatus(status: DspStatus, expected: MuxTarget, context: string): void {
  if (status.dispatchLifecycle !== "opened") {
    throw new Error(`${context} reported ${status.dispatchLifecycle}, expected opened.`);
  }
  if (!status.target) throw new Error(`${context} returned no persisted mux target.`);
  assertSameTarget(status.target, expected, `${context} persisted target`);
  if (status.muxStatus.state !== "running") {
    throw new Error(`${context} reported mux state ${status.muxStatus.state}, expected running.`);
  }
  assertSameTarget(status.muxStatus.target, expected, `${context} live target`);
}

function assertNewGeneration(previous: MuxTarget, next: MuxTarget): void {
  for (const field of ["workspaceId", "tabId", "paneId", "terminalId"] as const) {
    if (previous[field] === next[field]) {
      throw new Error(`External-close recovery reused ${field}; a new target generation was required.`);
    }
  }
  for (const field of ["version", "backend", "protocol", "canonicalCwd"] as const) {
    if (previous[field] !== next[field]) {
      throw new Error(`External-close recovery changed stable target field ${field}.`);
    }
  }
}

function qualificationProfile(
  options: WindowsMuxQualificationOptions,
): WindowsMuxQualificationProfile {
  if (options.exerciseExternalClose && options.close) return "full_lifecycle";
  if (options.exerciseExternalClose) return "external_recovery";
  if (options.close) return "terminal_close";
  return "open_status";
}

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

async function jsonCommand(
  executable: string,
  args: readonly string[],
  runner: ProcessRunner,
  operation: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<unknown> {
  if (!absolutePath(executable)) {
    throw new Error(`${operation} executable must be absolute: ${executable}`);
  }
  const result = await runner({
    executable,
    args: [...args],
    shell: false,
    ...(env === undefined ? {} : { env }),
  });
  if (!Number.isInteger(result.exitCode)) {
    throw new Error(`${operation} returned an invalid exit code.`);
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `${operation} failed with exit ${result.exitCode}: ${result.stderr.trim() || "no stderr"}`,
    );
  }
  if (result.stderr.trim().length > 0) {
    throw new Error(`${operation} wrote stderr on success: ${result.stderr.trim()}`);
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch (error) {
    throw new Error(`${operation} did not return exactly one valid JSON value.`, {
      cause: error,
    });
  }
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

function safeError(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: String(error) };
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

async function restoreFocus(
  herdr: string,
  original: FocusSnapshot | undefined,
  runner: ProcessRunner,
): Promise<Readonly<Record<string, unknown>>> {
  if (!original || original.focusedWorkspaceId === null) {
    return { attempted: false, outcome: "not_needed", workspaceId: null };
  }
  const workspaceId = original.focusedWorkspaceId;
  try {
    const current = focusSnapshot(
      await jsonCommand(herdr, ["api", "snapshot"], runner, "herdr focus restoration snapshot"),
    );
    if (current.focusedWorkspaceId === workspaceId) {
      return { attempted: false, outcome: "already_focused", workspaceId };
    }
    if (!current.workspaceIds.includes(workspaceId)) {
      return { attempted: false, outcome: "workspace_absent", workspaceId };
    }
    const result = await jsonCommand(
      herdr,
      ["workspace", "focus", workspaceId],
      runner,
      "herdr focus restoration",
    );
    herdrMutation(result, "workspace_info", "herdr focus restoration");
    const confirmed = focusSnapshot(
      await jsonCommand(herdr, ["api", "snapshot"], runner, "herdr focus confirmation"),
    );
    return confirmed.focusedWorkspaceId === workspaceId
      ? {
          attempted: true,
          outcome: "restored",
          workspaceId,
          resultType: "workspace_info",
        }
      : {
          attempted: true,
          outcome: "unconfirmed",
          workspaceId,
          resultType: "workspace_info",
        };
  } catch (error) {
    return { attempted: true, outcome: "failed", workspaceId, error: safeError(error) };
  }
}

export function parseWindowsMuxQualificationOptions(
  args: readonly string[],
): WindowsMuxQualificationOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const valueOptions = new Set(["--binary", "--sid", "--output", "--herdr"]);
  const flagOptions = new Set(["--exercise-external-close", "--close"]);

  for (let position = 0; position < args.length; position += 1) {
    const option = args[position]!;
    if (flagOptions.has(option)) {
      if (flags.has(option)) throw new Error(`Option may be supplied only once: ${option}`);
      flags.add(option);
      continue;
    }
    if (!valueOptions.has(option)) throw new Error(`Unknown option: ${option}`);
    if (values.has(option)) throw new Error(`Option may be supplied only once: ${option}`);
    const value = args[position + 1];
    if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
    values.set(option, value);
    position += 1;
  }

  const binary = values.get("--binary");
  const sid = values.get("--sid");
  if (!binary) throw new Error("--binary is required; qualification never selects a build implicitly.");
  if (!sid) throw new Error("--sid is required; qualification never creates or selects a session implicitly.");
  if (!isSortableId(sid)) throw new Error("--sid must be a canonical Dispatch session ID.");
  const output = values.get("--output");
  const herdr = values.get("--herdr");
  return {
    binary: resolve(binary),
    sid,
    exerciseExternalClose: flags.has("--exercise-external-close"),
    close: flags.has("--close"),
    ...(output === undefined ? {} : { output: resolve(output) }),
    ...(herdr === undefined ? {} : { herdr: resolve(herdr) }),
  };
}

export async function qualifyWindowsMux(
  options: WindowsMuxQualificationOptions,
  dependencies: QualificationDependencies = {},
): Promise<WindowsMuxQualificationEvidence> {
  const platform = dependencies.platform ?? process.platform;
  const architecture = dependencies.architecture ?? process.arch;
  if (platform !== "win32" || architecture !== "x64") {
    throw new Error(`Windows mux qualification requires native win32/x64, received ${platform}/${architecture}.`);
  }

  const runner = dependencies.runner ?? defaultRunner;
  const executableExists = dependencies.executableExists ?? defaultExecutableExists;
  const binary = executablePath(options.binary, "--binary", executableExists);
  const locatedHerdr = options.herdr ?? (dependencies.which ?? Bun.which)("herdr");
  if (!locatedHerdr) throw new Error("Herdr was not found on PATH; pass --herdr with its native executable path.");
  const herdr = executablePath(locatedHerdr, "Herdr executable", executableExists);
  const dspEnv = { ...process.env, DISPATCH_HERDR_BIN: herdr };
  if (
    options.output &&
    [binary, herdr].some(
      (executable) => pathIdentity(executable) === pathIdentity(options.output!),
    )
  ) {
    throw new Error("--output must not overwrite the Dispatch or Herdr executable.");
  }
  const hashExecutable = dependencies.sha256 ?? defaultSha256;
  const binarySha256 = hashExecutable(binary);
  const herdrSha256 = hashExecutable(herdr);
  const profile = qualificationProfile(options);
  const observations: Record<string, unknown> = {};
  const assertions: string[] = [];
  let originalFocus: FocusSnapshot | undefined;
  let focusRestoration: Readonly<Record<string, unknown>> = {
    attempted: false,
    outcome: "not_reached",
  };
  let failure: unknown;

  try {
    const doctor = doctorResult(
      await jsonCommand(binary, ["doctor", "--stage1", "--json"], runner, "dsp doctor --stage1", dspEnv),
    );
    observations.doctor = doctor;
    assertions.push("compiled doctor reports Stage 1 ready");

    originalFocus = focusSnapshot(
      await jsonCommand(herdr, ["api", "snapshot"], runner, "herdr initial focus snapshot"),
    );
    observations.initialFocus = originalFocus;

    const preflight = statusResult(
      await jsonCommand(binary, ["status", options.sid, "--json"], runner, "dsp preflight status", dspEnv),
      options.sid,
    );
    if (preflight.dispatchLifecycle === "closed" || preflight.dispatchLifecycle === "removed") {
      throw new Error(`Dedicated session is already ${preflight.dispatchLifecycle}; refusing to open it.`);
    }
    if (
      profile === "full_lifecycle" &&
      (preflight.dispatchLifecycle !== "created" ||
        preflight.target !== null ||
        preflight.muxStatus.state !== "not_recorded")
    ) {
      throw new Error(
        "Full lifecycle qualification requires a fresh created/not_recorded Dispatch session.",
      );
    }
    observations.preflightStatus = preflight;

    const opened = openResult(
      await jsonCommand(binary, ["open", options.sid, "--json"], runner, "dsp open", dspEnv),
      options.sid,
    );
    if (opened.projectionWarnings.length > 0) {
      throw new Error("dsp open reported projection warnings.");
    }
    if (
      profile === "full_lifecycle" &&
      (opened.disposition !== "created" || opened.receipt !== "recorded")
    ) {
      throw new Error(
        "Full lifecycle qualification requires the initial open to create and record a fresh target.",
      );
    }
    assertSameTarget(opened.target, opened.muxStatus.target, "Initial open");
    if (!opened.muxStatus.focused) throw new Error("Initial open did not focus its Herdr workspace.");
    observations.open = opened;

    const firstStatus = statusResult(
      await jsonCommand(binary, ["status", options.sid, "--json"], runner, "dsp status", dspEnv),
      options.sid,
    );
    assertRunningStatus(firstStatus, opened.target, "Initial status");
    observations.status = firstStatus;

    const idempotentOpen = openResult(
      await jsonCommand(binary, ["open", options.sid, "--json"], runner, "dsp idempotent open", dspEnv),
      options.sid,
    );
    assertSameTarget(idempotentOpen.target, opened.target, "Idempotent open");
    if (
      idempotentOpen.disposition !== "recovered" ||
      idempotentOpen.receipt !== "already_recorded"
    ) {
      throw new Error("Second open did not report recovered/already_recorded idempotency.");
    }
    if (idempotentOpen.projectionWarnings.length > 0) {
      throw new Error("Idempotent open reported projection warnings.");
    }
    observations.idempotentOpen = idempotentOpen;

    const idempotentStatus = statusResult(
      await jsonCommand(binary, ["status", options.sid, "--json"], runner, "dsp idempotent status", dspEnv),
      options.sid,
    );
    assertRunningStatus(idempotentStatus, opened.target, "Idempotent status");
    if (idempotentStatus.lastSeq !== firstStatus.lastSeq) {
      throw new Error("Idempotent open advanced the authoritative session ledger.");
    }
    observations.idempotentStatus = idempotentStatus;
    assertions.push("separate open/status processes preserve one exact target and ledger sequence");

    let finalTarget = opened.target;
    if (options.exerciseExternalClose) {
      const externalClose = await jsonCommand(
        herdr,
        ["workspace", "close", opened.target.workspaceId],
        runner,
        "external Herdr close",
      );
      observations.externalClose = herdrMutation(
        externalClose,
        "ok",
        "external Herdr close",
      );

      const absentStatus = statusResult(
        await jsonCommand(binary, ["status", options.sid, "--json"], runner, "dsp status after external close", dspEnv),
        options.sid,
      );
      if (!absentStatus.target) throw new Error("Status lost the persisted target after external close.");
      assertSameTarget(absentStatus.target, opened.target, "Externally closed persisted target");
      if (absentStatus.muxStatus.state !== "absent") {
        throw new Error("Status did not report the externally closed target as absent.");
      }
      assertSameTarget(absentStatus.muxStatus.target, opened.target, "Externally closed live target");
      if (absentStatus.lastSeq !== firstStatus.lastSeq) {
        throw new Error("External Herdr close unexpectedly changed the Dispatch ledger.");
      }
      observations.statusAfterExternalClose = absentStatus;

      const recovered = openResult(
        await jsonCommand(binary, ["open", options.sid, "--json"], runner, "dsp recovery open", dspEnv),
        options.sid,
      );
      if (recovered.projectionWarnings.length > 0) {
        throw new Error("Recovery open reported projection warnings.");
      }
      if (
        profile === "full_lifecycle" &&
        (recovered.disposition !== "created" || recovered.receipt !== "recorded")
      ) {
        throw new Error(
          "Full lifecycle qualification requires external-close recovery to create and record a fresh generation.",
        );
      }
      assertNewGeneration(opened.target, recovered.target);
      finalTarget = recovered.target;
      observations.recoveryOpen = recovered;

      const recoveredStatus = statusResult(
        await jsonCommand(binary, ["status", options.sid, "--json"], runner, "dsp recovery status", dspEnv),
        options.sid,
      );
      assertRunningStatus(recoveredStatus, recovered.target, "Recovery status");
      if (recoveredStatus.lastSeq <= absentStatus.lastSeq) {
        throw new Error("Recovery did not append a new target-generation receipt.");
      }
      observations.recoveryStatus = recoveredStatus;
      assertions.push("external close remains unreceipted until open records a wholly new target generation");
    }

    if (options.close) {
      const closed = closeResult(
        await jsonCommand(binary, ["close", options.sid, "--json"], runner, "dsp terminal close", dspEnv),
        options.sid,
      );
      if (!closed.target) throw new Error("Terminal close returned no mux target.");
      assertSameTarget(closed.target, finalTarget, "Terminal close");
      if (closed.muxOutcome !== "closed" || closed.alreadyClosed) {
        throw new Error("Terminal close did not close the current running generation exactly once.");
      }
      if (closed.projectionWarnings.length > 0) {
        throw new Error("Terminal close reported projection warnings.");
      }
      observations.close = closed;

      const closedStatus = statusResult(
        await jsonCommand(binary, ["status", options.sid, "--json"], runner, "dsp terminal status", dspEnv),
        options.sid,
      );
      if (closedStatus.dispatchLifecycle !== "closed") {
        throw new Error("Terminal status did not report the Dispatch session closed.");
      }
      if (!closedStatus.target) throw new Error("Terminal status lost the final mux target receipt.");
      assertSameTarget(closedStatus.target, finalTarget, "Terminal status persisted target");
      if (closedStatus.muxStatus.state !== "absent") {
        throw new Error("Terminal status did not report the closed mux generation absent.");
      }
      assertSameTarget(closedStatus.muxStatus.target, finalTarget, "Terminal status live target");
      observations.closedStatus = closedStatus;
      assertions.push("explicit terminal close preflight-verifies the full current generation, closes its workspace ID, and records terminal lifecycle");
    } else {
      assertions.push("terminal close was not requested and was not invoked");
    }
  } catch (error) {
    failure = error;
  } finally {
    focusRestoration = await restoreFocus(herdr, originalFocus, runner);
  }

  if (
    failure === undefined &&
    !["not_needed", "already_focused", "restored"].includes(
      String(focusRestoration.outcome),
    )
  ) {
    failure = new Error(
      `Operator focus was not restored after qualification: ${String(focusRestoration.outcome)}.`,
    );
  }

  const finalBinarySha256 = hashExecutable(binary);
  const finalHerdrSha256 = hashExecutable(herdr);
  if (
    failure === undefined &&
    (finalBinarySha256 !== binarySha256 || finalHerdrSha256 !== herdrSha256)
  ) {
    failure = new Error(
      "The Dispatch or Herdr executable changed during qualification.",
    );
  } else if (failure === undefined) {
    assertions.push("Dispatch and Herdr executable hashes remained stable throughout qualification");
  }

  const evidence: WindowsMuxQualificationEvidence = {
    schemaVersion: 1,
    generatedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    verdict: failure === undefined ? "pass" : "fail",
    scope: "native-windows-existing-dispatch-session",
    profile,
    completeLifecycle: profile === "full_lifecycle" && failure === undefined,
    inputs: {
      platform,
      architecture,
      binary: { path: binary, sha256: binarySha256 },
      herdr: { path: herdr, sha256: herdrSha256 },
      sid: options.sid,
      exerciseExternalClose: options.exerciseExternalClose,
      terminalCloseRequested: options.close,
    },
    assertions,
    observations,
    focusRestoration,
    ...(failure === undefined ? {} : { error: safeError(failure) }),
  };

  if (options.output) {
    (dependencies.writeEvidence ?? defaultWriteEvidence)(options.output, evidence);
  }
  if (failure !== undefined) {
    throw new Error(
      `Windows mux qualification failed: ${safeError(failure).message}${options.output ? `; evidence: ${options.output}` : ""}`,
      { cause: failure },
    );
  }
  return evidence;
}

if (import.meta.main) {
  const evidence = await qualifyWindowsMux(
    parseWindowsMuxQualificationOptions(process.argv.slice(2)),
  );
  console.log(JSON.stringify(evidence, null, 2));
}
