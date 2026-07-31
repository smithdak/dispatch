import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  arch,
  cpus,
  platform,
  release,
  tmpdir,
  totalmem,
  version as osVersion,
} from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { writeSessionMeta, sessionEventsPath } from "../src/application/session-meta";
import { createSortableId } from "../src/core/identity";
import { SessionIndex } from "../src/core/index";
import { JsonlLedger } from "../src/core/ledger";
import {
  ensureMachineId,
  ensureStateDirectories,
  resolveDispatchPaths,
  type Environment,
} from "../src/core/paths";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..");
const DEFAULT_BINARY = join(
  REPOSITORY_ROOT,
  "dist",
  process.platform === "win32" ? "dsp.exe" : "dsp",
);
const TARGETS_MS = {
  cliColdStart: 25,
  hookProcessAppend: 5,
  query500Sessions: 50,
} as const;

export interface BenchmarkOptions {
  readonly binary: string;
  readonly iterations: number;
  readonly warmup: number;
  readonly sessions: number;
  readonly output?: string;
}

export interface SampleSummary {
  readonly count: number;
  readonly minimumMs: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly maximumMs: number;
  readonly meanMs: number;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function percentile(sorted: readonly number[], quantile: number): number {
  const position = Math.max(0, Math.ceil(quantile * sorted.length) - 1);
  return sorted[position]!;
}

export function summarizeSamples(samples: readonly number[]): SampleSummary {
  if (samples.length === 0 || samples.some((sample) => !Number.isFinite(sample) || sample < 0)) {
    throw new TypeError("Samples must contain at least one finite, non-negative duration.");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const mean = sorted.reduce((sum, sample) => sum + sample, 0) / sorted.length;
  return {
    count: sorted.length,
    minimumMs: roundMilliseconds(sorted[0]!),
    medianMs: roundMilliseconds(percentile(sorted, 0.5)),
    p95Ms: roundMilliseconds(percentile(sorted, 0.95)),
    maximumMs: roundMilliseconds(sorted.at(-1)!),
    meanMs: roundMilliseconds(mean),
  };
}

function positiveInteger(value: string, name: string, maximum: number): number {
  if (!/^\d+$/.test(value)) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new RangeError(`${name} must be between 1 and ${maximum}.`);
  }
  return parsed;
}

export function parseBenchmarkOptions(
  args: readonly string[],
  defaults: { readonly binary?: string } = {},
): BenchmarkOptions {
  const values = new Map<string, string>();
  const definitions = new Set(["--binary", "--iterations", "--warmup", "--sessions", "--output"]);

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]!;
    if (!definitions.has(option)) throw new TypeError(`Unknown option: ${option}`);
    if (values.has(option)) throw new TypeError(`Option may be supplied only once: ${option}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new TypeError(`${option} requires a value.`);
    values.set(option, value);
    index += 1;
  }

  const binaryValue = values.get("--binary") ?? defaults.binary ?? DEFAULT_BINARY;
  const outputValue = values.get("--output");
  return {
    binary: resolve(binaryValue),
    iterations: positiveInteger(values.get("--iterations") ?? "30", "--iterations", 1_000),
    warmup: positiveInteger(values.get("--warmup") ?? "5", "--warmup", 100),
    sessions: positiveInteger(values.get("--sessions") ?? "500", "--sessions", 10_000),
    ...(outputValue === undefined
      ? {}
      : { output: isAbsolute(outputValue) ? outputValue : resolve(outputValue) }),
  };
}

function runCommand(
  command: readonly string[],
  options: { readonly env?: Environment; readonly stdin?: string } = {},
): CommandResult {
  const started = performance.now();
  const result = Bun.spawnSync([...command], {
    cwd: REPOSITORY_ROOT,
    env: options.env ?? process.env,
    stdin: options.stdin === undefined
      ? "ignore"
      : new Blob([`${options.stdin}\n`]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const durationMs = performance.now() - started;
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0) {
    throw new Error(
      `${JSON.stringify(command)} failed (${result.exitCode}): ${stderr.trim()}`,
    );
  }
  return { stdout: stdout.trim(), stderr: stderr.trim(), durationMs };
}

function deterministicEntropy(value: number): Uint8Array {
  const bytes = new Uint8Array(16);
  let remaining = value + 1;
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = remaining & 31;
    remaining = Math.floor(remaining / 32);
  }
  return bytes;
}

async function seedSessions(
  environment: Environment,
  root: string,
  count: number,
): Promise<{ readonly benchmarkSid: string; readonly benchmarkWorktree: string }> {
  const paths = resolveDispatchPaths(environment);
  ensureStateDirectories(paths);
  const machineId = ensureMachineId(paths);
  const repositoryPath = join(root, "repository");
  const worktreesPath = join(root, "worktrees");
  mkdirSync(repositoryPath, { recursive: true });
  mkdirSync(worktreesPath, { recursive: true });

  const index = new SessionIndex(paths.indexPath);
  let benchmarkSid = "";
  let benchmarkWorktree = "";
  try {
    for (let position = 0; position < count; position += 1) {
      const timestamp = 1_767_225_600_000 + position;
      const sid = createSortableId({
        timestamp,
        randomBytes: () => deterministicEntropy(position),
      });
      const worktreePath = join(worktreesPath, `session-${position.toString().padStart(4, "0")}`);
      const createdAt = new Date(timestamp).toISOString();
      const meta = {
        v: 1 as const,
        sid,
        mid: machineId,
        repositoryPath,
        worktreePath,
        branch: `dispatch-benchmark/session-${position}`,
        baseBranch: "main",
        baseCommit: "0000000000000000000000000000000000000000",
        createdAt,
      };
      const event = await new JsonlLedger({
        eventsPath: sessionEventsPath(paths, sid),
        sessionId: sid,
        machineId,
        clock: () => new Date(timestamp),
        idFactory: () =>
          createSortableId({
            timestamp,
            randomBytes: () => deterministicEntropy(count + position),
          }),
        // Fixture construction is outside the measurement boundary. Timed
        // hook appends use the product default, including fsync.
        syncWrites: false,
      }).append({
        src: "dsp",
        kind: "session.created",
        data: {
          repositoryPath,
          worktreePath,
          branch: meta.branch,
          baseBranch: meta.baseBranch,
          baseCommit: meta.baseCommit,
          createdAt,
        },
      });
      writeSessionMeta(paths, meta);
      index.upsertSession(meta);
      index.projectEvent(event);
      if (position === count - 1) {
        benchmarkSid = sid;
        benchmarkWorktree = worktreePath;
      }
    }
  } finally {
    index.close();
  }
  return { benchmarkSid, benchmarkWorktree };
}

function isolatedEnvironment(root: string): Environment {
  const home = join(root, "home");
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(root, "appdata", "roaming"),
    LOCALAPPDATA: join(root, "appdata", "local"),
    XDG_STATE_HOME: join(root, "xdg-state"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_CACHE_HOME: join(root, "xdg-cache"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    DISPATCH_HOME: join(root, "state"),
    DISPATCH_WORKTREE_ROOT: join(root, "worktrees"),
    DISPATCH_BRANCH_PREFIX: "dispatch-benchmark/",
  };
}

function gitValue(args: readonly string[]): string {
  return runCommand([
    "git",
    "-c",
    `safe.directory=${REPOSITORY_ROOT.replaceAll("\\", "/")}`,
    ...args,
  ]).stdout;
}

function targetObservations(summary: SampleSummary, targetMs: number) {
  return {
    targetMsExclusive: targetMs,
    medianUnderTarget: summary.medianMs < targetMs,
    p95UnderTarget: summary.p95Ms < targetMs,
    maximumUnderTarget: summary.maximumMs < targetMs,
  };
}

function writeEvidence(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

async function main(): Promise<void> {
  const options = parseBenchmarkOptions(process.argv.slice(2));
  if (!existsSync(options.binary)) {
    throw new Error(`Compiled binary does not exist: ${options.binary}; run bun run build first.`);
  }

  const root = mkdtempSync(join(tmpdir(), "dispatch-stage0-benchmark-"));
  try {
    const environment = isolatedEnvironment(root);
    const fixture = await seedSessions(environment, root, options.sessions);
    const doctor = JSON.parse(
      runCommand([options.binary, "doctor", "--json"], { env: environment }).stdout,
    ) as {
      readonly readyForStage0?: boolean;
      readonly checks?: ReadonlyArray<{ readonly name?: string; readonly detail?: string }>;
    };
    if (doctor.readyForStage0 !== true) {
      throw new Error("The compiled binary did not report Stage 0 readiness.");
    }
    const compiledBun = doctor.checks?.find((check) => check.name === "bun")?.detail;
    const binaryVersion = runCommand([options.binary, "--version"], { env: environment }).stdout;

    const coldStartSamples: number[] = [];
    const hookSamples: number[] = [];
    const querySamples: number[] = [];
    const hookPayload = JSON.stringify({
      session_id: "stage0-local-benchmark",
      transcript_path: join(root, "transcript.jsonl"),
      cwd: fixture.benchmarkWorktree,
      permission_mode: "default",
      hook_event_name: "SessionStart",
      source: "startup",
    });

    for (let position = 0; position < options.warmup; position += 1) {
      runCommand([options.binary, "--version"], { env: environment });
      runCommand([options.binary, "hook", "claude"], {
        env: environment,
        stdin: hookPayload,
      });
      const query = JSON.parse(
        runCommand(
          [options.binary, "ls", "--limit", String(options.sessions), "--json"],
          { env: environment },
        ).stdout,
      ) as unknown[];
      if (query.length !== options.sessions) {
        throw new Error(`Warm query returned ${query.length} sessions; expected ${options.sessions}.`);
      }
    }

    for (let position = 0; position < options.iterations; position += 1) {
      coldStartSamples.push(
        runCommand([options.binary, "--version"], { env: environment }).durationMs,
      );
      hookSamples.push(
        runCommand([options.binary, "hook", "claude"], {
          env: environment,
          stdin: hookPayload,
        }).durationMs,
      );
      const query = runCommand(
        [options.binary, "ls", "--limit", String(options.sessions), "--json"],
        { env: environment },
      );
      const sessions = JSON.parse(query.stdout) as unknown[];
      if (sessions.length !== options.sessions) {
        throw new Error(`Measured query returned ${sessions.length} sessions; expected ${options.sessions}.`);
      }
      querySamples.push(query.durationMs);
    }

    const logged = JSON.parse(
      runCommand([options.binary, "log", fixture.benchmarkSid, "--json"], {
        env: environment,
      }).stdout,
    ) as Array<{ readonly kind?: string }>;
    const capturedHooks = logged.filter((event) => event.kind === "agent.started").length;
    if (capturedHooks !== options.warmup + options.iterations) {
      throw new Error(
        `Expected ${options.warmup + options.iterations} captured hooks; observed ${capturedHooks}.`,
      );
    }

    const coldStart = summarizeSamples(coldStartSamples);
    const hookAppend = summarizeSamples(hookSamples);
    const query = summarizeSamples(querySamples);
    const dirtyPaths = gitValue(["status", "--short"])
      .split(/\r?\n/)
      .filter(Boolean);
    const cpu = cpus()[0];
    const evidence = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      evidence: {
        machineLocal: {
          scope: "single-machine compiled-process measurement",
          source: {
            gitHead: gitValue(["rev-parse", "HEAD"]),
            workingTreeDirty: dirtyPaths.length > 0,
            dirtyPaths,
          },
          binary: {
            path: relative(REPOSITORY_ROOT, options.binary) || options.binary,
            sha256: createHash("sha256").update(readFileSync(options.binary)).digest("hex"),
            dispatchVersion: binaryVersion,
            embeddedBun: compiledBun ?? "unknown",
          },
          harness: {
            bun: Bun.version,
            codexManagedEnvironment:
              process.env.CODEX_THREAD_ID !== undefined ||
              process.env.CODEX_SANDBOX_NETWORK_DISABLED !== undefined,
          },
          host: {
            platform: platform(),
            architecture: arch(),
            osRelease: release(),
            osVersion: osVersion(),
            logicalProcessors: cpus().length,
            cpuModel: cpu?.model.trim() ?? "unknown",
            totalMemoryBytes: totalmem(),
          },
          method: {
            processBoundary: "Bun.spawnSync around a fresh compiled dsp process",
            storage: "isolated temporary Dispatch state on the host default temporary filesystem",
            warmupIterations: options.warmup,
            measuredIterations: options.iterations,
            sessionFixtureCount: options.sessions,
            cacheQualification: "processes are fresh; operating-system file and image caches are not flushed",
            hookDurability: "product-default fsync enabled",
          },
          measurements: {
            cliColdStart: {
              command: "dsp --version",
              samplesMs: coldStartSamples.map(roundMilliseconds),
              summary: coldStart,
              targetObservation: targetObservations(coldStart, TARGETS_MS.cliColdStart),
            },
            hookProcessAppend: {
              command: "dsp hook claude",
              samplesMs: hookSamples.map(roundMilliseconds),
              summary: hookAppend,
              targetObservation: targetObservations(hookAppend, TARGETS_MS.hookProcessAppend),
              capturedEvents: capturedHooks,
            },
            sessionQuery: {
              command: `dsp ls --limit ${options.sessions} --json`,
              samplesMs: querySamples.map(roundMilliseconds),
              summary: query,
              targetObservation:
                options.sessions === 500
                  ? targetObservations(query, TARGETS_MS.query500Sessions)
                  : null,
            },
          },
        },
        ci: {
          status: "not-collected",
          reason: "This local benchmark does not query GitHub Actions.",
        },
        liveClaude: {
          status: "not-collected",
          reason: "Fixture-backed stdin is not evidence of a real Claude Code invocation.",
        },
      },
    };

    if (options.output) writeEvidence(options.output, evidence);
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}

if (import.meta.main) {
  await main();
}
