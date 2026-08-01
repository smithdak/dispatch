import { createHash, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  win32,
} from "node:path";

import { isSortableId } from "../src/core/identity";

const REQUIRED_BUN_VERSION = "1.3.14";
const REQUIRED_DISPATCH_VERSION = "0.2.0-alpha.3";
const DEFAULT_SESSION_PREFIX = "dispatch-prompt-qual";
const SYNTHETIC_SOURCE = "dispatch-prompt-qualifier";
const SYNTHETIC_AGENT = "codex";
const SYNTHETIC_READY_MARKER = "DISPATCH_SYNTHETIC_CODEX_READY_V1";

type JsonRecord = Record<string, unknown>;

export interface WindowsPromptQualificationOptions {
  readonly binary: string;
  readonly output: string;
  readonly herdr?: string;
  readonly herdrSessionPrefix?: string;
}

export interface PromptProcessInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly shell: false;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  /** Ephemeral process input. Qualifiers and evidence must never retain it. */
  readonly stdin?: string;
}

export interface PromptProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type PromptProcessRunner = (
  invocation: PromptProcessInvocation,
) => Promise<PromptProcessResult>;

export type PromptServerStarter = (
  herdr: string,
  session: string,
  env: Readonly<Record<string, string | undefined>>,
) => void | Promise<void>;

export interface WindowsPromptQualificationDependencies {
  readonly runner?: PromptProcessRunner;
  readonly startServer?: PromptServerStarter;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly bunVersion?: string;
  readonly bunExecutable?: string;
  readonly which?: (executable: string) => string | null;
  readonly executableExists?: (path: string) => boolean;
  readonly sha256?: (path: string) => string;
  readonly now?: () => Date;
  readonly sessionNonce?: () => string;
  readonly promptNonce?: () => string;
  readonly createTempRoot?: () => string;
  readonly removeTempRoot?: (path: string) => void;
  readonly readText?: (path: string) => string;
  readonly writeEvidence?: (path: string, evidence: unknown) => void;
  readonly readinessAttempts?: number;
  readonly outputAttempts?: number;
}

interface ServerNamespace {
  readonly session: string;
  readonly socket: string;
}

interface SourceSnapshot {
  readonly commit: string;
  readonly branch: string;
}

interface PromptTarget {
  readonly version: 2;
  readonly backend: "herdr";
  readonly protocol: 18;
  readonly server: ServerNamespace;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly paneId: string;
  readonly terminalId: string;
  readonly canonicalCwd: string;
}

export interface WindowsPromptQualificationEvidence {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly verdict: "pass" | "fail";
  readonly scope: "native-windows-isolated-herdr-private-prompt";
  readonly source: {
    readonly commit: string;
    readonly branch: string;
    readonly cleanBeforeAndAfter: boolean;
  };
  readonly inputs: {
    readonly platform: string;
    readonly architecture: string;
    readonly bunVersion: string;
    readonly dispatchVersion: string;
    readonly binary: { readonly path: string; readonly sha256: string };
    readonly bun: { readonly path: string; readonly sha256: string };
    readonly herdr: { readonly path: string; readonly sha256: string };
    readonly qualifier: { readonly path: string; readonly sha256: string };
    readonly syntheticAgent: {
      readonly name: "codex";
      readonly sha256: string | null;
    };
    readonly herdrSession: string;
  };
  readonly isolation: {
    readonly generatedSessionNonce: true;
    readonly preexistingSessionAbsent: boolean;
    readonly isolatedDispatchHome: boolean;
    readonly disposableRepository: boolean;
    readonly isolatedHerdrConfig: boolean;
    readonly paneHistoryDisabled: boolean;
    readonly defaultSessionAddressed: false;
    readonly externalModelInvoked: false;
  };
  readonly observation: {
    readonly sid: string | null;
    readonly target: PromptTarget | null;
    readonly promptId: string | null;
    readonly promptAccepted: boolean;
    readonly syntheticAgentReady: boolean;
    readonly outputObserved: boolean;
    readonly intentEventId: string | null;
    readonly acceptedEventId: string | null;
  };
  readonly privacy: {
    readonly promptEnteredThroughStdinOnly: boolean;
    readonly candidateArgvPrivateValuesAbsent: boolean;
    readonly candidateEnvironmentPrivateValuesAbsent: boolean;
    readonly herdrArgvPrivateValuesAbsent: boolean;
    readonly allQualifierChildArgvPrivateValuesAbsent: boolean;
    readonly ledgerCanaryAbsent: boolean;
    readonly ledgerBodyAbsent: boolean;
    readonly receiptsBodyFree: boolean;
  };
  readonly cleanup: {
    readonly agentReleased: boolean;
    readonly terminalClosed: boolean;
    readonly worktreeRemoved: boolean;
    readonly namedSessionStopped: boolean;
    readonly namedSessionDeleted: boolean;
    readonly tempFilesRemoved: boolean;
    readonly errors: readonly string[];
  };
  readonly assertions: readonly string[];
  readonly limitations: readonly string[];
  readonly error?: { readonly name: string; readonly message: string };
}

const defaultRunner: PromptProcessRunner = async (invocation) => {
  const child = Bun.spawn([invocation.executable, ...invocation.args], {
    ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
    ...(invocation.env === undefined ? {} : { env: invocation.env }),
    stdin: invocation.stdin === undefined
      ? "ignore"
      : new Blob([invocation.stdin]),
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const defaultStartServer: PromptServerStarter = (herdr, session, environment) => {
  const env = { ...environment };
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

function requiredBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be boolean.`);
  return value;
}

function requiredArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
  return value;
}

function absolutePath(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value);
}

function pathIdentity(value: string): string {
  return win32.normalize(value).toLowerCase();
}

function sameTarget(left: PromptTarget, right: PromptTarget): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
}

function validatePrefix(value: string): void {
  if (
    value === "default" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/.test(value)
  ) {
    throw new Error(
      "--herdr-session-prefix must be a non-default 1-30 character argv-safe value.",
    );
  }
}

function nonce(value: string, label: string): string {
  if (!/^[a-f0-9]{32}$/.test(value)) {
    throw new Error(`${label} must be 128-bit lowercase hexadecimal.`);
  }
  return value;
}

function executablePath(
  value: string,
  label: string,
  executableExists: (path: string) => boolean,
): string {
  if (!absolutePath(value)) throw new Error(`${label} must be an absolute path.`);
  if ([".bat", ".cmd"].includes(extname(value).toLowerCase())) {
    throw new Error(`${label} must be a native executable, not a shell shim.`);
  }
  if (!executableExists(value)) throw new Error(`${label} does not exist: ${value}`);
  return value;
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

function syntheticAgentSource(): string {
  return [
    'import { Buffer } from "node:buffer";',
    'import { createInterface } from "node:readline";',
    "const keepAlive = setInterval(() => {}, 2_147_483_647);",
    "void (async () => {",
    `  console.log(${JSON.stringify(SYNTHETIC_READY_MARKER)});`,
    "  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });",
    "  for await (const line of lines) {",
    '    if (!line.startsWith("QUALIFY ")) continue;',
    '    const encoded = line.slice("QUALIFY ".length).trim();',
    '    console.log(Buffer.from(encoded, "base64").toString("utf8"));',
    "  }",
    "})().finally(() => clearInterval(keepAlive));",
    "",
  ].join("\n");
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

function redact(value: string, privateValues: readonly string[]): string {
  let safe = value;
  for (const privateValue of privateValues) {
    if (privateValue.length > 0) safe = safe.replaceAll(privateValue, "[REDACTED]");
  }
  return safe;
}

function safeError(
  error: unknown,
  privateValues: readonly string[],
): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: redact(error.message, privateValues) }
    : { name: "Error", message: redact(String(error), privateValues) };
}

async function invoke(
  executable: string,
  args: readonly string[],
  runner: PromptProcessRunner,
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly cwd?: string;
    readonly stdin?: string;
  } = {},
): Promise<PromptProcessResult> {
  return runner({
    executable,
    args: [...args],
    shell: false,
    ...options,
  });
}

async function successful(
  executable: string,
  args: readonly string[],
  runner: PromptProcessRunner,
  operation: string,
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly cwd?: string;
    readonly stdin?: string;
  } = {},
): Promise<PromptProcessResult> {
  const result = await invoke(executable, args, runner, options);
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
  runner: PromptProcessRunner,
  operation: string,
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly cwd?: string;
    readonly stdin?: string;
  } = {},
): Promise<unknown> {
  const result = await successful(executable, args, runner, operation, options);
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch (error) {
    throw new Error(`${operation} did not return valid JSON.`, { cause: error });
  }
}

function sourceGitArgs(
  sourceRoot: string,
  args: readonly string[],
): readonly string[] {
  return [
    "-c",
    `safe.directory=${sourceRoot.replaceAll("\\", "/")}`,
    "-c",
    "core.excludesFile=",
    ...args,
  ];
}

async function sourceGitOutput(
  git: string,
  sourceRoot: string,
  args: readonly string[],
  runner: PromptProcessRunner,
  operation: string,
): Promise<string> {
  return (
    await successful(
      git,
      sourceGitArgs(sourceRoot, args),
      runner,
      operation,
      { env: process.env },
    )
  ).stdout.trim();
}

async function sourceSnapshot(
  git: string,
  sourceRoot: string,
  runner: PromptProcessRunner,
): Promise<SourceSnapshot> {
  const readCommit = () =>
    sourceGitOutput(
      git,
      sourceRoot,
      ["rev-parse", "--verify", "HEAD"],
      runner,
      "Read qualified source HEAD",
    );
  const readBranch = async (): Promise<string> => {
    const branch = await sourceGitOutput(
      git,
      sourceRoot,
      ["branch", "--show-current"],
      runner,
      "Read qualified source branch",
    );
    return branch.length === 0 ? "(detached)" : branch;
  };

  const beforeCommit = await readCommit();
  const beforeBranch = await readBranch();
  const status = await sourceGitOutput(
    git,
    sourceRoot,
    ["status", "--short", "--untracked-files=all"],
    runner,
    "Read qualified source status",
  );
  if (status.length > 0) {
    throw new Error(
      "Windows prompt qualification requires a clean source tree including untracked files.",
    );
  }
  const afterCommit = await readCommit();
  const afterBranch = await readBranch();
  if (beforeCommit !== afterCommit || beforeBranch !== afterBranch) {
    throw new Error("Qualified source HEAD or branch changed during provenance sampling.");
  }
  if (!/^[a-f0-9]{40}$/.test(afterCommit)) {
    throw new Error("Qualified source HEAD must be an exact 40-character lowercase commit SHA.");
  }
  return { commit: afterCommit, branch: afterBranch };
}

function sessionRows(value: unknown): readonly JsonRecord[] {
  return requiredArray(record(value, "Herdr session list").sessions, "Herdr session list.sessions")
    .map((row, index) => record(row, `Herdr session list.sessions[${index}]`));
}

async function sessions(
  herdr: string,
  runner: PromptProcessRunner,
): Promise<readonly JsonRecord[]> {
  return sessionRows(
    await jsonSuccess(herdr, ["session", "list", "--json"], runner, "Herdr session list"),
  );
}

function sessionRow(rows: readonly JsonRecord[], name: string): JsonRecord | undefined {
  return rows.find((row) => row.name === name);
}

function parseServer(value: unknown, expectedSession: string): ServerNamespace {
  const payload = record(value, "Herdr status");
  const client = record(payload.client, "Herdr status.client");
  const server = record(payload.server, "Herdr status.server");
  if (
    client.protocol !== 18 ||
    server.protocol !== 18 ||
    server.running !== true ||
    server.compatible !== true ||
    client.session !== expectedSession ||
    server.session !== expectedSession
  ) {
    throw new Error("Herdr status did not prove the selected protocol-18 named session.");
  }
  const socket = requiredString(server.socket, "Herdr status.server.socket");
  if (!absolutePath(socket)) throw new Error("Herdr named-session socket must be absolute.");
  return { session: expectedSession, socket };
}

async function serverStatus(
  herdr: string,
  session: string,
  runner: PromptProcessRunner,
): Promise<ServerNamespace> {
  return parseServer(
    await jsonSuccess(
      herdr,
      ["--session", session, "status", "--json"],
      runner,
      "Herdr named-session status",
    ),
    session,
  );
}

async function waitForServer(
  herdr: string,
  session: string,
  runner: PromptProcessRunner,
  sleep: (milliseconds: number) => Promise<void>,
  attempts: number,
): Promise<ServerNamespace> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await serverStatus(herdr, session, runner);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await sleep(100);
    }
  }
  throw new Error(`Named Herdr session ${session} did not become ready.`, {
    cause: lastError,
  });
}

async function waitForPaneOutput(
  herdr: string,
  session: string,
  paneId: string,
  canary: string,
  runner: PromptProcessRunner,
  sleep: (milliseconds: number) => Promise<void>,
  attempts: number,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await successful(
      herdr,
      [
        "--session",
        session,
        "pane",
        "read",
        paneId,
        "--source",
        "recent-unwrapped",
        "--lines",
        "200",
        "--format",
        "text",
      ],
      runner,
      "Read isolated pane output",
    );
    if (result.stdout.includes(canary)) return;
    if (attempt + 1 < attempts) await sleep(100);
  }
  throw new Error("The isolated pane did not emit the private prompt output canary.");
}

function parseTarget(
  value: unknown,
  expectedServer: ServerNamespace,
  expectedCwd: string,
  path: string,
): PromptTarget {
  const item = record(value, path);
  const server = record(item.server, `${path}.server`);
  const target: PromptTarget = {
    version: item.version === 2 ? 2 : (() => { throw new Error(`${path}.version must be 2.`); })(),
    backend: item.backend === "herdr" ? "herdr" : (() => { throw new Error(`${path}.backend must be herdr.`); })(),
    protocol: item.protocol === 18 ? 18 : (() => { throw new Error(`${path}.protocol must be 18.`); })(),
    server: {
      session: requiredString(server.session, `${path}.server.session`),
      socket: requiredString(server.socket, `${path}.server.socket`),
    },
    workspaceId: requiredString(item.workspaceId, `${path}.workspaceId`),
    tabId: requiredString(item.tabId, `${path}.tabId`),
    paneId: requiredString(item.paneId, `${path}.paneId`),
    terminalId: requiredString(item.terminalId, `${path}.terminalId`),
    canonicalCwd: requiredString(item.canonicalCwd, `${path}.canonicalCwd`),
  };
  if (
    target.server.session !== expectedServer.session ||
    target.server.socket !== expectedServer.socket
  ) {
    throw new Error(`${path} escaped the isolated Herdr namespace.`);
  }
  if (pathIdentity(target.canonicalCwd) !== pathIdentity(expectedCwd)) {
    throw new Error(`${path} escaped the disposable worktree.`);
  }
  return target;
}

interface LedgerProof {
  readonly intentEventId: string;
  readonly acceptedEventId: string;
  readonly canaryAbsent: true;
  readonly bodyAbsent: true;
  readonly receiptsBodyFree: true;
}

function ledgerProof(
  raw: string,
  promptId: string,
  canary: string,
  body: string,
  encodedCanary: string,
): LedgerProof {
  if (!raw.endsWith("\n")) throw new Error("Dispatch ledger is not newline committed.");
  if (raw.includes(canary)) throw new Error("The private canary leaked into the Dispatch ledger.");
  if (raw.includes(body)) throw new Error("The private prompt body leaked into the Dispatch ledger.");
  if (raw.includes(encodedCanary)) {
    throw new Error("The encoded private output marker leaked into the Dispatch ledger.");
  }
  const events = raw.slice(0, -1).split("\n").map((line, index) => {
    try {
      return record(JSON.parse(line) as unknown, `ledger event ${index + 1}`);
    } catch (error) {
      throw new Error(`Ledger event ${index + 1} is invalid JSON.`, { cause: error });
    }
  });
  const promptEvents = events.filter((event) => {
    if (event.kind !== "agent.state" || !isRecord(event.data)) return false;
    return event.data.operation === "prompt" && event.data.promptId === promptId;
  });
  const byState = new Map<string, JsonRecord>();
  for (const event of promptEvents) {
    const data = record(event.data, "prompt receipt.data");
    const state = requiredString(data.state, "prompt receipt.data.state");
    if (byState.has(state)) throw new Error(`Prompt receipt ${state} was duplicated.`);
    const allowed = new Set([
      "operation",
      "state",
      "promptId",
      "transport",
      "muxTarget",
      ...(state === "prompt.intent" ? ["preflightAgentStatus"] : []),
      ...(state === "prompt.accepted" ? ["agentStatus"] : []),
    ]);
    for (const key of Object.keys(data)) {
      if (!allowed.has(key)) throw new Error(`Prompt receipt ${state} retained unexpected field ${key}.`);
    }
    if (data.transport !== "herdr_named_pipe") {
      throw new Error(`Prompt receipt ${state} recorded the wrong transport.`);
    }
    record(data.muxTarget, `prompt receipt ${state}.muxTarget`);
    byState.set(state, event);
  }
  if (promptEvents.length !== 2 || !byState.has("prompt.intent") || !byState.has("prompt.accepted")) {
    throw new Error("The ledger must contain exactly one prompt.intent and one prompt.accepted receipt.");
  }
  return {
    intentEventId: requiredString(byState.get("prompt.intent")!.id, "prompt.intent.id"),
    acceptedEventId: requiredString(byState.get("prompt.accepted")!.id, "prompt.accepted.id"),
    canaryAbsent: true,
    bodyAbsent: true,
    receiptsBodyFree: true,
  };
}

export function parseWindowsPromptQualificationOptions(
  args: readonly string[],
): WindowsPromptQualificationOptions {
  const values = new Map<string, string>();
  const supported = new Set([
    "--binary",
    "--output",
    "--herdr",
    "--herdr-session-prefix",
  ]);
  for (let position = 0; position < args.length; position += 1) {
    const option = args[position]!;
    if (!supported.has(option)) throw new Error(`Unknown option: ${option}`);
    if (values.has(option)) throw new Error(`Option may be supplied only once: ${option}`);
    const value = args[position + 1];
    if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
    values.set(option, value);
    position += 1;
  }
  const binary = values.get("--binary");
  const output = values.get("--output");
  if (!binary) throw new Error("--binary is required; qualification never selects a build implicitly.");
  if (!output) throw new Error("--output is required so pass and failure evidence is retained.");
  if (extname(output).toLowerCase() !== ".json") {
    throw new Error("--output must be a raw .json receipt path.");
  }
  const prefix = values.get("--herdr-session-prefix");
  if (prefix !== undefined) validatePrefix(prefix);
  const herdr = values.get("--herdr");
  return {
    binary: resolve(binary),
    output: resolve(output),
    ...(herdr === undefined ? {} : { herdr: resolve(herdr) }),
    ...(prefix === undefined ? {} : { herdrSessionPrefix: prefix }),
  };
}

export async function qualifyWindowsPrompt(
  options: WindowsPromptQualificationOptions,
  dependencies: WindowsPromptQualificationDependencies = {},
): Promise<WindowsPromptQualificationEvidence> {
  const platform = dependencies.platform ?? process.platform;
  const architecture = dependencies.architecture ?? process.arch;
  const bunVersion = dependencies.bunVersion ?? Bun.version;
  if (platform !== "win32" || architecture !== "x64") {
    throw new Error(`Windows prompt qualification requires native win32/x64, received ${platform}/${architecture}.`);
  }
  if (bunVersion !== REQUIRED_BUN_VERSION) {
    throw new Error(`Windows prompt qualification requires Bun ${REQUIRED_BUN_VERSION}, received ${bunVersion}.`);
  }
  const prefix = options.herdrSessionPrefix ?? DEFAULT_SESSION_PREFIX;
  validatePrefix(prefix);
  if (extname(options.output).toLowerCase() !== ".json") {
    throw new Error("--output must be a raw .json receipt path.");
  }

  const baseRunner = dependencies.runner ?? defaultRunner;
  const executableExists = dependencies.executableExists ?? defaultExecutableExists;
  const binary = executablePath(options.binary, "--binary", executableExists);
  const bunExecutable = executablePath(
    dependencies.bunExecutable ?? process.execPath,
    "Bun executable",
    executableExists,
  );
  const locatedHerdr = options.herdr ?? (dependencies.which ?? Bun.which)("herdr");
  if (!locatedHerdr) throw new Error("Herdr was not found on PATH; pass --herdr explicitly.");
  const herdr = executablePath(locatedHerdr, "Herdr executable", executableExists);
  const locatedGit = (dependencies.which ?? Bun.which)("git");
  if (!locatedGit) throw new Error("Git was not found on PATH.");
  const git = executablePath(locatedGit, "Git executable", executableExists);
  const qualifierPath = resolve(import.meta.dir, "qualify-windows-prompt.ts");
  const sourceRoot = resolve(import.meta.dir, "..");
  const output = resolve(options.output);
  if (isInside(sourceRoot, output)) {
    throw new Error("--output must be outside the qualified source tree.");
  }
  for (const protectedPath of [binary, bunExecutable, herdr, git, qualifierPath]) {
    if (pathIdentity(protectedPath) === pathIdentity(output)) {
      throw new Error("--output must not overwrite a qualified executable or the qualifier source.");
    }
  }

  // Use the operator process environment and a process-local safe.directory.
  // This must succeed before any temp directory or Herdr namespace is touched.
  const sourceBefore = await sourceSnapshot(git, sourceRoot, baseRunner);

  const hash = dependencies.sha256 ?? defaultSha256;
  const binarySha256 = hash(binary);
  const bunSha256 = hash(bunExecutable);
  const herdrSha256 = hash(herdr);
  const qualifierSha256 = hash(qualifierPath);
  const sessionNonce = nonce(
    (dependencies.sessionNonce ?? (() => randomBytes(16).toString("hex")))(),
    "Herdr session nonce",
  );
  const promptNonce = nonce(
    (dependencies.promptNonce ?? (() => randomBytes(16).toString("hex")))(),
    "Prompt canary nonce",
  );
  const herdrSession = `${prefix}-${sessionNonce}`;
  // Herdr's existing Windows qualifier permits 64-character session names.
  // This qualifier deliberately stays at or below 63 characters.
  if (herdrSession.length > 63) {
    throw new Error("Generated Herdr session name exceeds the 63-character qualifier limit.");
  }
  const canary = `DISPATCH_PROMPT_QUAL_${promptNonce}`;
  const encodedCanary = Buffer.from(canary, "utf8").toString("base64");
  const promptBody = `QUALIFY ${encodedCanary}`;
  if (promptBody.includes(canary)) {
    throw new Error("Qualification prompt body must not contain its output canary.");
  }
  const privateValues = [promptBody, canary, encodedCanary];
  let candidateArgvPrivateValuesAbsent = true;
  let herdrArgvPrivateValuesAbsent = true;
  let allQualifierChildArgvPrivateValuesAbsent = true;
  let herdrEnvironment: Readonly<Record<string, string | undefined>> | undefined;
  const runner: PromptProcessRunner = async (invocation) => {
    const privateArgument = invocation.args.some((argument) =>
      privateValues.some((value) => argument.includes(value))
    );
    if (privateArgument) {
      allQualifierChildArgvPrivateValuesAbsent = false;
      if (pathIdentity(invocation.executable) === pathIdentity(binary)) {
        candidateArgvPrivateValuesAbsent = false;
      }
      if (pathIdentity(invocation.executable) === pathIdentity(herdr)) {
        herdrArgvPrivateValuesAbsent = false;
      }
      throw new Error("Private prompt data was placed in child argv.");
    }
    return baseRunner(
      herdrEnvironment !== undefined &&
          pathIdentity(invocation.executable) === pathIdentity(herdr)
        ? { ...invocation, env: herdrEnvironment }
        : invocation,
    );
  };
  const createTempRoot = dependencies.createTempRoot ?? (() =>
    mkdtempSync(join(tmpdir(), "dispatch-windows-prompt-")));
  const removeTempRoot = dependencies.removeTempRoot ?? ((path: string) =>
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const tempRoot = resolve(createTempRoot());
  const repository = join(tempRoot, "repository");
  const dispatchHome = join(tempRoot, "dispatch-home");
  const worktreeRoot = join(tempRoot, "worktrees");
  const isolatedHome = join(tempRoot, "home");
  const isolatedTemp = join(tempRoot, "temp");
  const herdrConfigPath = join(tempRoot, "herdr-config.toml");
  const syntheticAgentDirectory = join(tempRoot, "synthetic-agent");
  const syntheticAgentEntry = join(syntheticAgentDirectory, "main.ts");
  const syntheticAgentExecutable = join(syntheticAgentDirectory, "codex.exe");
  for (const directory of [
    dispatchHome,
    worktreeRoot,
    isolatedHome,
    isolatedTemp,
    syntheticAgentDirectory,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(syntheticAgentEntry, syntheticAgentSource(), "utf8");
  writeFileSync(
    herdrConfigPath,
    "[experimental]\npane_history = false\n",
    "utf8",
  );
  const herdrEnv: Readonly<Record<string, string | undefined>> = {
    ...process.env,
    HERDR_CONFIG_PATH: herdrConfigPath,
    TEMP: isolatedTemp,
    TMP: isolatedTemp,
  };
  herdrEnvironment = herdrEnv;
  const dspEnv: Readonly<Record<string, string | undefined>> = {
    ...process.env,
    DISPATCH_HOME: dispatchHome,
    DISPATCH_WORKTREE_ROOT: worktreeRoot,
    DISPATCH_BRANCH_PREFIX: "dispatch-prompt-qualification/",
    DISPATCH_HERDR_BIN: herdr,
    DISPATCH_HERDR_SESSION: herdrSession,
    HERDR_CONFIG_PATH: herdrConfigPath,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    TEMP: isolatedTemp,
    TMP: isolatedTemp,
  };
  const starter = dependencies.startServer ?? defaultStartServer;
  const sleep = dependencies.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
  const readinessAttempts = dependencies.readinessAttempts ?? 100;
  const outputAttempts = dependencies.outputAttempts ?? 100;
  const readText = dependencies.readText ?? ((path: string) => readFileSync(path, "utf8"));
  const assertions: string[] = [];
  const cleanupErrors: string[] = [];
  let failure: unknown;
  let sourceCleanBeforeAndAfter = false;
  let preexistingSessionAbsent = false;
  let paneHistoryDisabled = false;
  let ownedNamedSession = false;
  let namedSessionStarted = false;
  let namedSessionStopped = false;
  let namedSessionDeleted = false;
  let sid: string | null = null;
  let worktreePath: string | null = null;
  let target: PromptTarget | null = null;
  let promptId: string | null = null;
  let promptAccepted = false;
  let syntheticAgentReady = false;
  let outputObserved = false;
  let agentReported = false;
  let agentReleased = false;
  let terminalClosed = false;
  let worktreeRemoved = false;
  let tempFilesRemoved = false;
  let promptEnteredThroughStdinOnly = false;
  let candidateEnvironmentPrivateValuesAbsent = true;
  let ledgerCanaryAbsent = false;
  let ledgerBodyAbsent = false;
  let receiptsBodyFree = false;
  let intentEventId: string | null = null;
  let acceptedEventId: string | null = null;
  let selectedServer: ServerNamespace | null = null;
  let syntheticAgentSha256: string | null = null;

  const candidate = async (
    args: readonly string[],
    operation: string,
    stdin?: string,
  ): Promise<unknown> => {
    if (args.some((argument) => privateValues.some((value) => argument.includes(value)))) {
      candidateArgvPrivateValuesAbsent = false;
      throw new Error("Private prompt data was placed in candidate argv.");
    }
    if (
      Object.values(dspEnv).some((entry) =>
        typeof entry === "string" && privateValues.some((value) => entry.includes(value))
      )
    ) {
      candidateEnvironmentPrivateValuesAbsent = false;
      throw new Error("Private prompt data was placed in the candidate environment.");
    }
    return jsonSuccess(binary, args, runner, operation, {
      env: dspEnv,
      ...(stdin === undefined ? {} : { stdin }),
    });
  };

  try {
    await successful(
      herdr,
      ["config", "check"],
      runner,
      "Validate isolated Herdr configuration",
    );
    paneHistoryDisabled = true;
    const initialRows = await sessions(herdr, runner);
    if (sessionRow(initialRows, herdrSession)) {
      throw new Error(
        `Internally named Herdr session ${herdrSession} already exists; refusing to claim or mutate it.`,
      );
    }
    preexistingSessionAbsent = true;
    ownedNamedSession = true;
    await starter(herdr, herdrSession, herdrEnv);
    selectedServer = await waitForServer(
      herdr,
      herdrSession,
      runner,
      sleep,
      readinessAttempts,
    );
    namedSessionStarted = true;
    const runningRow = sessionRow(await sessions(herdr, runner), herdrSession);
    if (!runningRow || runningRow.running !== true) {
      throw new Error("The isolated Herdr session was not listed as running.");
    }
    assertions.push("an internally generated named Herdr session was absent before start");
    assertions.push("the isolated Herdr server used an explicit validated pane_history=false configuration");

    await successful(git, ["init", "--initial-branch=main", "--", repository], runner, "Initialize disposable Git repository", { env: dspEnv });
    await successful(git, ["-C", repository, "config", "user.name", "Dispatch Qualification"], runner, "Configure disposable Git user name", { env: dspEnv });
    await successful(git, ["-C", repository, "config", "user.email", "dispatch-qualification@example.invalid"], runner, "Configure disposable Git user email", { env: dspEnv });
    await successful(git, ["-C", repository, "-c", "commit.gpgSign=false", "-c", "core.hooksPath=", "commit", "--allow-empty", "-m", "initial"], runner, "Commit disposable Git baseline", { env: dspEnv });

    await successful(
      bunExecutable,
      [
        "build",
        syntheticAgentEntry,
        "--compile",
        "--no-compile-autoload-dotenv",
        "--no-compile-autoload-bunfig",
        `--outfile=${syntheticAgentExecutable}`,
      ],
      runner,
      "Compile disposable synthetic Codex agent",
      { env: dspEnv },
    );
    if (!existsSync(syntheticAgentExecutable)) {
      throw new Error("Bun did not produce the disposable synthetic codex.exe.");
    }
    syntheticAgentSha256 = hash(syntheticAgentExecutable);

    const versionResult = await successful(binary, ["--version"], runner, "Read candidate Dispatch version", { env: dspEnv });
    if (versionResult.stdout.trim() !== REQUIRED_DISPATCH_VERSION) {
      throw new Error(`Candidate Dispatch version must be ${REQUIRED_DISPATCH_VERSION}.`);
    }
    const doctor = record(await candidate(["doctor", "--stage1", "--json"], "Candidate Stage 1 doctor"), "dsp doctor");
    if (requiredBoolean(doctor.readyForStage1, "dsp doctor.readyForStage1") !== true) {
      throw new Error("Candidate doctor did not qualify Stage 1.");
    }
    const doctorServer = record(doctor.herdrServer, "dsp doctor.herdrServer");
    if (
      doctorServer.session !== selectedServer.session ||
      doctorServer.socket !== selectedServer.socket
    ) {
      throw new Error("Candidate doctor did not resolve the isolated Herdr namespace.");
    }

    const created = record(
      await candidate(
        ["new", "Windows private prompt qualification", "--repo", repository, "--json"],
        "Create disposable Dispatch session",
      ),
      "dsp new",
    );
    sid = requiredString(created.sid, "dsp new.sid");
    if (!isSortableId(sid)) throw new Error("dsp new returned a non-canonical SID.");
    worktreePath = requiredString(created.worktreePath, "dsp new.worktreePath");
    const createdRepository = requiredString(created.repositoryPath, "dsp new.repositoryPath");
    if (pathIdentity(createdRepository) !== pathIdentity(repository)) {
      throw new Error("dsp new returned a different disposable repository path.");
    }
    if (!isInside(tempRoot, worktreePath)) {
      throw new Error("dsp new created a worktree outside the disposable root.");
    }

    const opened = record(
      await candidate(["open", sid, "--json"], "Open isolated Dispatch terminal"),
      "dsp open",
    );
    if (opened.sid !== sid || opened.disposition !== "created") {
      throw new Error("dsp open did not create the fresh isolated target.");
    }
    if (opened.receipt !== "recorded" || opened.recovery !== null) {
      throw new Error("dsp open did not durably record a fresh target receipt.");
    }
    target = parseTarget(opened.target, selectedServer, worktreePath, "dsp open.target");

    const escapedSyntheticAgent = syntheticAgentExecutable.replaceAll("'", "''");
    await successful(
      herdr,
      [
        "--session",
        herdrSession,
        "pane",
        "run",
        target.paneId,
        `& '${escapedSyntheticAgent}'`,
      ],
      runner,
      "Launch disposable synthetic Codex agent",
    );
    await waitForPaneOutput(
      herdr,
      herdrSession,
      target.paneId,
      SYNTHETIC_READY_MARKER,
      runner,
      sleep,
      outputAttempts,
    );
    syntheticAgentReady = true;

    await successful(
      herdr,
      [
        "--session",
        herdrSession,
        "pane",
        "report-agent",
        target.paneId,
        "--source",
        SYNTHETIC_SOURCE,
        "--agent",
        SYNTHETIC_AGENT,
        "--state",
        "idle",
        "--seq",
        "1",
      ],
      runner,
      "Report synthetic qualification agent",
    );
    agentReported = true;
    const status = record(
      await candidate(["status", sid, "--json"], "Verify synthetic agent status"),
      "dsp status",
    );
    const muxStatus = record(status.muxStatus, "dsp status.muxStatus");
    if (muxStatus.state !== "running" || muxStatus.agentStatus !== "idle") {
      throw new Error("Synthetic qualification agent did not become idle.");
    }
    const statusTarget = parseTarget(muxStatus.target, selectedServer, worktreePath, "dsp status.muxStatus.target");
    if (!sameTarget(statusTarget, target)) throw new Error("Synthetic agent status changed the target generation.");

    const promptArgs = ["prompt", sid, "--stdin", "--json"] as const;
    promptEnteredThroughStdinOnly = true;
    const prompted = record(
      await candidate(promptArgs, "Submit private prompt through stdin", `${promptBody}\n`),
      "dsp prompt",
    );
    if (prompted.sid !== sid || prompted.receipt !== "accepted") {
      throw new Error("dsp prompt did not return an accepted receipt.");
    }
    promptId = requiredString(prompted.promptId, "dsp prompt.promptId");
    if (!isSortableId(promptId)) throw new Error("dsp prompt returned a non-canonical prompt ID.");
    const promptTarget = parseTarget(prompted.target, selectedServer, worktreePath, "dsp prompt.target");
    if (!sameTarget(promptTarget, target)) throw new Error("dsp prompt acknowledged a different target generation.");
    if (requiredArray(prompted.projectionWarnings, "dsp prompt.projectionWarnings").length !== 0) {
      throw new Error("dsp prompt reported projection warnings.");
    }
    promptAccepted = true;

    await waitForPaneOutput(
      herdr,
      herdrSession,
      target.paneId,
      canary,
      runner,
      sleep,
      outputAttempts,
    );
    outputObserved = true;

    const ledgerPath = join(dispatchHome, "sessions", sid, "events.jsonl");
    const proof = ledgerProof(
      readText(ledgerPath),
      promptId,
      canary,
      promptBody,
      encodedCanary,
    );
    ledgerCanaryAbsent = proof.canaryAbsent;
    ledgerBodyAbsent = proof.bodyAbsent;
    receiptsBodyFree = proof.receiptsBodyFree;
    intentEventId = proof.intentEventId;
    acceptedEventId = proof.acceptedEventId;
    assertions.push("candidate prompt body crossed stdin and never candidate argv or environment");
    assertions.push("raw ledger contains body-free prompt.intent and prompt.accepted receipts");
    assertions.push("a disposable native codex.exe line-reader emitted the internally generated canary without a model invocation");
  } catch (error) {
    failure = error;
  } finally {
    if (agentReported && target && namedSessionStarted && !agentReleased) {
      try {
        await successful(
          herdr,
          ["--session", herdrSession, "pane", "release-agent", target.paneId, "--source", SYNTHETIC_SOURCE, "--agent", SYNTHETIC_AGENT, "--seq", "2"],
          runner,
          "Release synthetic qualification agent",
        );
        agentReleased = true;
      } catch (error) {
        cleanupErrors.push(`agent release: ${safeError(error, privateValues).message}`);
      }
    }
    if (sid && target && namedSessionStarted && !terminalClosed) {
      try {
        const closed = record(await candidate(["close", sid, "--json"], "Close isolated Dispatch terminal"), "dsp close");
        if (closed.sid !== sid || !["closed", "already_absent"].includes(String(closed.muxOutcome))) {
          throw new Error("dsp close did not confirm isolated terminal closure.");
        }
        terminalClosed = true;
      } catch (error) {
        cleanupErrors.push(`terminal close: ${safeError(error, privateValues).message}`);
      }
    }
    if (sid && !worktreeRemoved) {
      try {
        const removed = record(await candidate(["remove", sid, "--force", "--json"], "Remove disposable Dispatch worktree"), "dsp remove");
        if (worktreePath && pathIdentity(requiredString(removed.worktreePath, "dsp remove.worktreePath")) !== pathIdentity(worktreePath)) {
          throw new Error("dsp remove returned a different worktree path.");
        }
        worktreeRemoved = true;
      } catch (error) {
        cleanupErrors.push(`worktree remove: ${safeError(error, privateValues).message}`);
      }
    }
    if (ownedNamedSession) {
      try {
        const row = sessionRow(await sessions(herdr, runner), herdrSession);
        if (row?.running === true) {
          await successful(herdr, ["--session", herdrSession, "server", "stop"], runner, "Stop isolated Herdr session");
        }
        const stopped = sessionRow(await sessions(herdr, runner), herdrSession);
        namedSessionStopped = stopped === undefined || stopped.running === false;
        if (stopped) {
          const deleted = record(
            await jsonSuccess(herdr, ["session", "delete", herdrSession, "--json"], runner, "Delete isolated Herdr session"),
            "Herdr session delete",
          );
          if (deleted.deleted !== true) throw new Error("Herdr did not confirm named-session deletion.");
        }
        namedSessionDeleted = sessionRow(await sessions(herdr, runner), herdrSession) === undefined;
      } catch (error) {
        cleanupErrors.push(`named session: ${safeError(error, privateValues).message}`);
      }
    }
    try {
      removeTempRoot(tempRoot);
      tempFilesRemoved = !existsSync(tempRoot);
      if (!tempFilesRemoved) throw new Error("Disposable qualification root still exists.");
    } catch (error) {
      cleanupErrors.push(`temp files: ${safeError(error, privateValues).message}`);
    }
  }

  if (failure === undefined && cleanupErrors.length > 0) {
    failure = new Error(cleanupErrors.join("; "));
  }
  if (
    failure === undefined &&
    (!promptAccepted ||
      !outputObserved ||
      !agentReleased ||
      !terminalClosed ||
      !worktreeRemoved ||
      !namedSessionStopped ||
      !namedSessionDeleted ||
      !tempFilesRemoved ||
      !ledgerCanaryAbsent ||
      !ledgerBodyAbsent ||
      !receiptsBodyFree)
  ) {
    failure = new Error("Windows prompt qualification did not complete every proof and cleanup assertion.");
  }
  if (failure === undefined) {
    try {
      const sourceAfter = await sourceSnapshot(git, sourceRoot, baseRunner);
      if (
        sourceAfter.commit !== sourceBefore.commit ||
        sourceAfter.branch !== sourceBefore.branch
      ) {
        throw new Error(
          "Qualified source HEAD or branch changed during Windows prompt qualification.",
        );
      }
      sourceCleanBeforeAndAfter = true;
      assertions.push(
        "clean source HEAD and branch remained identical before and after qualification",
      );
    } catch (error) {
      failure = error;
    }
  }
  if (
    failure === undefined &&
    (hash(binary) !== binarySha256 ||
      hash(bunExecutable) !== bunSha256 ||
      hash(herdr) !== herdrSha256 ||
      hash(qualifierPath) !== qualifierSha256)
  ) {
    failure = new Error("The Dispatch, Herdr, or qualifier artifact changed during qualification.");
  }

  const evidence: WindowsPromptQualificationEvidence = {
    schemaVersion: 1,
    generatedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    verdict: failure === undefined ? "pass" : "fail",
    scope: "native-windows-isolated-herdr-private-prompt",
    source: {
      commit: sourceBefore.commit,
      branch: sourceBefore.branch,
      cleanBeforeAndAfter: sourceCleanBeforeAndAfter,
    },
    inputs: {
      platform,
      architecture,
      bunVersion,
      dispatchVersion: REQUIRED_DISPATCH_VERSION,
      binary: { path: binary, sha256: binarySha256 },
      bun: { path: bunExecutable, sha256: bunSha256 },
      herdr: { path: herdr, sha256: herdrSha256 },
      qualifier: { path: qualifierPath, sha256: qualifierSha256 },
      syntheticAgent: { name: "codex", sha256: syntheticAgentSha256 },
      herdrSession,
    },
    isolation: {
      generatedSessionNonce: true,
      preexistingSessionAbsent,
      isolatedDispatchHome: isInside(tempRoot, dispatchHome),
      disposableRepository: isInside(tempRoot, repository),
      isolatedHerdrConfig: isInside(tempRoot, herdrConfigPath),
      paneHistoryDisabled,
      defaultSessionAddressed: false,
      externalModelInvoked: false,
    },
    observation: {
      sid,
      target,
      promptId,
      promptAccepted,
      syntheticAgentReady,
      outputObserved,
      intentEventId,
      acceptedEventId,
    },
    privacy: {
      promptEnteredThroughStdinOnly,
      candidateArgvPrivateValuesAbsent,
      candidateEnvironmentPrivateValuesAbsent,
      herdrArgvPrivateValuesAbsent,
      allQualifierChildArgvPrivateValuesAbsent,
      ledgerCanaryAbsent,
      ledgerBodyAbsent,
      receiptsBodyFree,
    },
    cleanup: {
      agentReleased,
      terminalClosed,
      worktreeRemoved,
      namedSessionStopped,
      namedSessionDeleted,
      tempFilesRemoved,
      errors: cleanupErrors,
    },
    assertions,
    limitations: [
      "The receipt proves one prompt reached a disposable native codex.exe line-reader and pane output; it does not qualify OpenAI Codex, a paid provider, a provider transcript, or a completed model turn.",
      "Herdr protocol 18 cannot condition agent.prompt on terminal_id, so the adapter's preflight-to-write generation race remains bounded but not eliminated.",
      "Herdr exposes no server-process ownership token; the internally generated 128-bit session-name nonce makes accidental collision negligible but does not authenticate the serving process against an adversarial local actor.",
      "The canary necessarily appears transiently in Dispatch memory, the private named pipe, the isolated shell pane, and pane-read stdout; it is excluded from every child argv, candidate environment, Dispatch ledger, and retained evidence.",
    ],
    ...(failure === undefined ? {} : { error: safeError(failure, privateValues) }),
  };
  const serializedEvidence = JSON.stringify(evidence);
  if (privateValues.some((value) => serializedEvidence.includes(value))) {
    throw new Error("Refusing to retain qualification evidence containing private prompt data.");
  }
  (dependencies.writeEvidence ?? defaultWriteEvidence)(output, evidence);
  if (failure !== undefined) {
    throw new Error(
      `Windows prompt qualification failed: ${safeError(failure, privateValues).message}; evidence: ${output}`,
      { cause: failure },
    );
  }
  return evidence;
}

if (import.meta.main) {
  const evidence = await qualifyWindowsPrompt(
    parseWindowsPromptQualificationOptions(process.argv.slice(2)),
  );
  console.log(JSON.stringify(evidence, null, 2));
}
