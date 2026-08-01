import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  parseWindowsPromptQualificationOptions,
  qualifyWindowsPrompt,
  type PromptProcessInvocation,
  type PromptProcessResult,
  type WindowsPromptQualificationDependencies,
  type WindowsPromptQualificationEvidence,
} from "../../scripts/qualify-windows-prompt";

const sid = "01kywyrp5e-2y5qv64427d1npck";
const promptId = "01kywyrp5f-2y5qv64427d1npck";
const sessionNonce = "a".repeat(32);
const promptNonce = "b".repeat(32);
const sessionPrefix = "dispatch-prompt-test";
const herdrSession = `${sessionPrefix}-${sessionNonce}`;
const canary = `DISPATCH_PROMPT_QUAL_${promptNonce}`;
const encodedCanary = Buffer.from(canary, "utf8").toString("base64");
const promptBody = `QUALIFY ${encodedCanary}`;
const binary = "C:\\qualification\\dsp.exe";
const bun = "C:\\qualification\\bun.exe";
const herdr = "C:\\qualification\\herdr.exe";
const git = "C:\\qualification\\git.exe";
const socket = `C:\\qualification\\${herdrSession}.sock`;
const sourceCommit = "1".repeat(40);
const driftCommit = "2".repeat(40);
const sourceBranch = "agent/windows-private-prompt";
const sourceRoot = resolve(import.meta.dir, "../..");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function ok(value = ""): PromptProcessResult {
  return { exitCode: 0, stdout: value, stderr: "" };
}

function json(value: unknown): PromptProcessResult {
  return ok(JSON.stringify(value));
}

function target(worktreePath: string) {
  return {
    version: 2,
    backend: "herdr",
    protocol: 18,
    server: { session: herdrSession, socket },
    workspaceId: "workspace-private",
    tabId: "workspace-private:tab",
    paneId: "workspace-private:pane",
    terminalId: "terminal-private",
    canonicalCwd: worktreePath,
  } as const;
}

function event(
  sequence: number,
  id: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  return {
    v: 1,
    id,
    sid,
    seq: sequence,
    ts: "2026-07-31T12:00:00.000Z",
    mid: "qualification-machine",
    src: "dsp",
    kind: "agent.state",
    data,
  };
}

interface Harness {
  readonly dependencies: WindowsPromptQualificationDependencies;
  readonly invocations: PromptProcessInvocation[];
  readonly evidence: WindowsPromptQualificationEvidence[];
  readonly root: string;
  readonly worktreePath: string;
  readonly counters: {
    starts: number;
    stops: number;
    deletes: number;
    releases: number;
    tempCreates: number;
  };
}

function harness(options: {
  readonly preexisting?: boolean;
  readonly leakLedger?: boolean;
  readonly dirtySource?: boolean;
  readonly driftSource?: boolean;
} = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "dispatch-prompt-qualifier-test-"));
  temporaryRoots.push(root);
  const worktreePath = join(root, "worktrees", "repository", `qualification-${sid}`);
  const invocations: PromptProcessInvocation[] = [];
  const evidence: WindowsPromptQualificationEvidence[] = [];
  const counters = {
    starts: 0,
    stops: 0,
    deletes: 0,
    releases: 0,
    tempCreates: 0,
  };
  let namedExists = options.preexisting ?? false;
  let namedRunning = options.preexisting ?? false;
  let syntheticAgentLaunched = false;
  let promptSubmitted = false;
  let syntheticAgentExecutable: string | undefined;
  let sourceCommitReads = 0;

  const runner = async (
    invocation: PromptProcessInvocation,
  ): Promise<PromptProcessResult> => {
    invocations.push(invocation);
    const args = invocation.args;
    if (invocation.executable === git) {
      const sourceInvocation = args.some((argument) =>
        argument.startsWith("safe.directory=")
      );
      if (!sourceInvocation) return ok();
      expect(invocation.env).toBe(process.env);
      expect(args).toContain(`safe.directory=${sourceRoot.replaceAll("\\", "/")}`);
      expect(args).toContain("core.excludesFile=");
      if (args.includes("rev-parse")) {
        sourceCommitReads += 1;
        return ok(
          `${options.driftSource && sourceCommitReads > 2 ? driftCommit : sourceCommit}\n`,
        );
      }
      if (args.includes("branch")) return ok(`${sourceBranch}\n`);
      if (args.includes("status")) {
        expect(args).toContain("--untracked-files=all");
        return ok(options.dirtySource ? "?? untracked-source-file\n" : "");
      }
      throw new Error(`Unexpected source Git invocation: ${args.join(" ")}`);
    }
    if (invocation.executable === bun) {
      expect(args[0]).toBe("build");
      const source = readFileSync(args[1]!, "utf8");
      expect(source).toContain("createInterface");
      expect(source).toContain("setInterval");
      expect(source).toContain("clearInterval");
      expect(source).toContain("QUALIFY ");
      expect(source).not.toContain(canary);
      const output = args.find((argument) => argument.startsWith("--outfile="));
      expect(output).toBeDefined();
      syntheticAgentExecutable = output!.slice("--outfile=".length);
      writeFileSync(syntheticAgentExecutable, "synthetic executable", "utf8");
      return ok();
    }
    if (invocation.executable === herdr) {
      expect(invocation.env?.HERDR_CONFIG_PATH).toBe(join(root, "herdr-config.toml"));
      if (args.join("\0") === ["config", "check"].join("\0")) return ok("valid\n");
      if (args.join("\0") === ["session", "list", "--json"].join("\0")) {
        return json({
          sessions: namedExists
            ? [{ name: herdrSession, running: namedRunning }]
            : [],
        });
      }
      if (
        args.join("\0") ===
          ["--session", herdrSession, "status", "--json"].join("\0")
      ) {
        return json({
          client: { protocol: 18, session: herdrSession },
          server: {
            protocol: 18,
            running: true,
            compatible: true,
            session: herdrSession,
            socket,
          },
        });
      }
      if (args.includes("report-agent")) return ok();
      if (args.includes("run")) {
        expect(syntheticAgentExecutable).toBeDefined();
        expect(args.at(-1)).toBe(`& '${syntheticAgentExecutable!.replaceAll("'", "''")}'`);
        syntheticAgentLaunched = true;
        return ok();
      }
      if (args.includes("read")) {
        expect(args).not.toContain(canary);
        expect(syntheticAgentLaunched).toBe(true);
        return ok(
          promptSubmitted
            ? `DISPATCH_SYNTHETIC_CODEX_READY_V1\n${canary}\n`
            : "DISPATCH_SYNTHETIC_CODEX_READY_V1\n",
        );
      }
      if (args.includes("release-agent")) {
        counters.releases += 1;
        return ok();
      }
      if (args.join("\0") === ["--session", herdrSession, "server", "stop"].join("\0")) {
        namedRunning = false;
        counters.stops += 1;
        return ok();
      }
      if (args.join("\0") === ["session", "delete", herdrSession, "--json"].join("\0")) {
        namedExists = false;
        counters.deletes += 1;
        return json({ deleted: true });
      }
      throw new Error(`Unexpected Herdr invocation: ${args.join(" ")}`);
    }
    if (invocation.executable !== binary) {
      throw new Error(`Unexpected executable: ${invocation.executable}`);
    }
    if (args.join("\0") === ["--version"].join("\0")) {
      return ok("0.2.0-alpha.3\n");
    }
    if (args[0] === "doctor") {
      return json({
        readyForStage0: true,
        readyForStage1: true,
        herdrServer: { session: herdrSession, socket },
        checks: [],
      });
    }
    if (args[0] === "new") {
      mkdirSync(worktreePath, { recursive: true });
      return json({
        v: 1,
        sid,
        mid: "qualification-machine",
        repositoryPath: join(root, "repository"),
        worktreePath,
        branch: `dispatch-prompt-qualification/qualification-${sid}`,
        baseBranch: "main",
        baseCommit: "1".repeat(40),
        createdAt: "2026-07-31T12:00:00.000Z",
      });
    }
    if (args[0] === "open") {
      return json({
        sid,
        target: target(worktreePath),
        disposition: "created",
        receipt: "recorded",
        recovery: null,
        muxStatus: {
          state: "running",
          target: target(worktreePath),
          focused: true,
        },
        projectionWarnings: [],
      });
    }
    if (args[0] === "status") {
      return json({
        sid,
        dispatchLifecycle: "opened",
        lastSeq: 3,
        target: target(worktreePath),
        muxStatus: {
          state: "running",
          target: target(worktreePath),
          focused: true,
          agentStatus: "idle",
        },
      });
    }
    if (args[0] === "prompt") {
      expect(args).toEqual(["prompt", sid, "--stdin", "--json"]);
      expect(invocation.stdin).toBe(`${promptBody}\n`);
      promptSubmitted = true;
      const ledgerPath = join(
        invocation.env!.DISPATCH_HOME!,
        "sessions",
        sid,
        "events.jsonl",
      );
      mkdirSync(resolve(ledgerPath, ".."), { recursive: true });
      const promptEvents = [
        event(4, "event-intent", {
          operation: "prompt",
          state: "prompt.intent",
          promptId,
          transport: "herdr_named_pipe",
          muxTarget: target(worktreePath),
          preflightAgentStatus: "idle",
        }),
        event(5, "event-accepted", {
          operation: "prompt",
          state: "prompt.accepted",
          promptId,
          transport: "herdr_named_pipe",
          muxTarget: target(worktreePath),
          agentStatus: "idle",
          ...(options.leakLedger ? { outputMarker: canary } : {}),
        }),
      ];
      writeFileSync(
        ledgerPath,
        `${promptEvents.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
        "utf8",
      );
      return json({
        sid,
        promptId,
        target: target(worktreePath),
        agentStatus: "idle",
        receipt: "accepted",
        projectionWarnings: [],
      });
    }
    if (args[0] === "close") {
      return json({
        sid,
        target: target(worktreePath),
        muxOutcome: "closed",
        alreadyClosed: false,
        receipt: "recorded",
        projectionWarnings: [],
      });
    }
    if (args[0] === "remove") {
      return json({
        repositoryPath: join(root, "repository"),
        worktreePath,
        forced: true,
        wasDirty: false,
        alreadyAbsent: false,
      });
    }
    throw new Error(`Unexpected candidate invocation: ${args.join(" ")}`);
  };

  return {
    root,
    worktreePath,
    invocations,
    evidence,
    counters,
    dependencies: {
      runner,
      startServer: async (_herdr, session, env) => {
        expect(session).toBe(herdrSession);
        expect(env.HERDR_CONFIG_PATH).toBe(join(root, "herdr-config.toml"));
        counters.starts += 1;
        namedExists = true;
        namedRunning = true;
      },
      sleep: async () => {},
      platform: "win32",
      architecture: "x64",
      bunVersion: "1.3.14",
      bunExecutable: bun,
      which: (name) => name === "herdr" ? herdr : name === "git" ? git : null,
      executableExists: () => true,
      sha256: () => "f".repeat(64),
      now: () => new Date("2026-07-31T12:00:00.000Z"),
      sessionNonce: () => sessionNonce,
      promptNonce: () => promptNonce,
      createTempRoot: () => {
        counters.tempCreates += 1;
        return root;
      },
      removeTempRoot: (path) => {
        rmSync(path, { recursive: true, force: true });
      },
      writeEvidence: (_path, value) => {
        evidence.push(value as WindowsPromptQualificationEvidence);
      },
      readinessAttempts: 1,
      outputAttempts: 1,
    },
  };
}

function qualificationOptions() {
  return {
    binary,
    herdr,
    output: join(tmpdir(), "dispatch-prompt-qualification-receipt.json"),
    herdrSessionPrefix: sessionPrefix,
  } as const;
}

describe("native Windows private-prompt qualification", () => {
  test("requires an explicit candidate and raw JSON evidence path", () => {
    expect(() => parseWindowsPromptQualificationOptions([])).toThrow("--binary is required");
    expect(() => parseWindowsPromptQualificationOptions(["--binary", binary])).toThrow("--output is required");
    expect(() =>
      parseWindowsPromptQualificationOptions([
        "--binary",
        binary,
        "--output",
        "receipt.txt",
      ])
    ).toThrow("raw .json");
    expect(() =>
      parseWindowsPromptQualificationOptions([
        "--binary",
        binary,
        "--output",
        "receipt.json",
        "--binary",
        binary,
      ])
    ).toThrow("only once");
    expect(() =>
      parseWindowsPromptQualificationOptions([
        "--binary",
        binary,
        "--output",
        "receipt.json",
        "--unknown",
        "value",
      ])
    ).toThrow("Unknown option");
  });

  test("qualifies one stdin-only prompt in a disposable named session and cleans every owned resource", async () => {
    const fixture = harness();
    const evidence = await qualifyWindowsPrompt(
      qualificationOptions(),
      fixture.dependencies,
    );

    expect(evidence.verdict).toBe("pass");
    expect(evidence.source).toEqual({
      commit: sourceCommit,
      branch: sourceBranch,
      cleanBeforeAndAfter: true,
    });
    expect(evidence.isolation).toEqual({
      generatedSessionNonce: true,
      preexistingSessionAbsent: true,
      isolatedDispatchHome: true,
      disposableRepository: true,
      isolatedHerdrConfig: true,
      paneHistoryDisabled: true,
      defaultSessionAddressed: false,
      externalModelInvoked: false,
    });
    expect(evidence.observation).toMatchObject({
      sid,
      promptId,
      promptAccepted: true,
      syntheticAgentReady: true,
      outputObserved: true,
      intentEventId: "event-intent",
      acceptedEventId: "event-accepted",
    });
    expect(evidence.privacy).toEqual({
      promptEnteredThroughStdinOnly: true,
      candidateArgvPrivateValuesAbsent: true,
      candidateEnvironmentPrivateValuesAbsent: true,
      herdrArgvPrivateValuesAbsent: true,
      allQualifierChildArgvPrivateValuesAbsent: true,
      ledgerCanaryAbsent: true,
      ledgerBodyAbsent: true,
      receiptsBodyFree: true,
    });
    expect(evidence.cleanup).toMatchObject({
      agentReleased: true,
      terminalClosed: true,
      worktreeRemoved: true,
      namedSessionStopped: true,
      namedSessionDeleted: true,
      tempFilesRemoved: true,
      errors: [],
    });
    expect(fixture.counters).toEqual({
      starts: 1,
      stops: 1,
      deletes: 1,
      releases: 1,
      tempCreates: 1,
    });
    expect(evidence.inputs.herdrSession.length).toBeLessThanOrEqual(63);
    expect(evidence.inputs.syntheticAgent).toEqual({
      name: "codex",
      sha256: "f".repeat(64),
    });
    const compile = fixture.invocations.find((item) => item.executable === bun);
    expect(compile?.args).toEqual([
      "build",
      join(fixture.root, "synthetic-agent", "main.ts"),
      "--compile",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      `--outfile=${join(fixture.root, "synthetic-agent", "codex.exe")}`,
    ]);
    expect(existsSync(fixture.root)).toBe(false);
    expect(fixture.evidence).toHaveLength(1);

    const candidateInvocations = fixture.invocations.filter((item) => item.executable === binary);
    expect(candidateInvocations.some((item) => item.args[0] === "new")).toBe(true);
    expect(candidateInvocations.some((item) => item.args[0] === "open")).toBe(true);
    const promptInvocation = candidateInvocations.find((item) => item.args[0] === "prompt");
    expect(promptInvocation?.stdin).toBe(`${promptBody}\n`);
    expect(promptBody).not.toContain(canary);
    for (const invocation of candidateInvocations) {
      expect(invocation.args.join("\0")).not.toContain(canary);
      expect(invocation.args.join("\0")).not.toContain(promptBody);
      expect(JSON.stringify(invocation.env)).not.toContain(canary);
    }
    expect(promptInvocation?.env?.APPDATA).toBe(process.env.APPDATA);
    expect(promptInvocation?.env?.LOCALAPPDATA).toBe(process.env.LOCALAPPDATA);
    expect(JSON.stringify(evidence)).not.toContain(canary);
    expect(JSON.stringify(evidence)).not.toContain(promptBody);
    expect(JSON.stringify(evidence)).not.toContain(encodedCanary);
    for (const invocation of fixture.invocations) {
      expect(invocation.args.join("\0")).not.toContain(canary);
      expect(invocation.args.join("\0")).not.toContain(promptBody);
      expect(invocation.args.join("\0")).not.toContain(encodedCanary);
    }
    expect(fixture.invocations.some((item) =>
      item.executable === herdr && item.args.includes("default")
    )).toBe(false);
  });

  test("fails closed on a preexisting generated namespace and retains failure evidence without mutating it", async () => {
    const fixture = harness({ preexisting: true });
    await expect(
      qualifyWindowsPrompt(qualificationOptions(), fixture.dependencies),
    ).rejects.toThrow("already exists");

    expect(fixture.counters).toEqual({
      starts: 0,
      stops: 0,
      deletes: 0,
      releases: 0,
      tempCreates: 1,
    });
    expect(fixture.evidence).toHaveLength(1);
    expect(fixture.evidence[0]).toMatchObject({
      verdict: "fail",
      isolation: { preexistingSessionAbsent: false },
      cleanup: { tempFilesRemoved: true },
    });
    expect(existsSync(fixture.root)).toBe(false);
    expect(
      fixture.invocations.filter((item) => item.executable === binary),
    ).toHaveLength(0);
  });

  test("fails qualification on any raw-ledger canary leak while redacting retained evidence", async () => {
    const fixture = harness({ leakLedger: true });
    await expect(
      qualifyWindowsPrompt(qualificationOptions(), fixture.dependencies),
    ).rejects.toThrow("canary leaked");

    expect(fixture.evidence).toHaveLength(1);
    const evidence = fixture.evidence[0]!;
    expect(evidence.verdict).toBe("fail");
    expect(evidence.cleanup).toMatchObject({
      agentReleased: true,
      terminalClosed: true,
      worktreeRemoved: true,
      namedSessionStopped: true,
      namedSessionDeleted: true,
      tempFilesRemoved: true,
    });
    expect(JSON.stringify(evidence)).not.toContain(canary);
    expect(JSON.stringify(evidence)).not.toContain(promptBody);
    expect(JSON.stringify(evidence)).not.toContain(encodedCanary);
    expect(existsSync(fixture.root)).toBe(false);
  });

  test("rejects dirty tracked or untracked source before temp or Herdr mutation", async () => {
    const fixture = harness({ dirtySource: true });
    await expect(
      qualifyWindowsPrompt(qualificationOptions(), fixture.dependencies),
    ).rejects.toThrow("clean source tree including untracked files");

    expect(fixture.counters).toEqual({
      starts: 0,
      stops: 0,
      deletes: 0,
      releases: 0,
      tempCreates: 0,
    });
    expect(
      fixture.invocations.filter((item) => item.executable === herdr),
    ).toHaveLength(0);
    expect(
      fixture.invocations.filter((item) => item.executable === binary),
    ).toHaveLength(0);
    expect(fixture.evidence).toHaveLength(0);
  });

  test("retains failure evidence when source HEAD drifts after qualification", async () => {
    const fixture = harness({ driftSource: true });
    await expect(
      qualifyWindowsPrompt(qualificationOptions(), fixture.dependencies),
    ).rejects.toThrow("HEAD or branch changed during Windows prompt qualification");

    expect(fixture.evidence).toHaveLength(1);
    expect(fixture.evidence[0]).toMatchObject({
      verdict: "fail",
      source: {
        commit: sourceCommit,
        branch: sourceBranch,
        cleanBeforeAndAfter: false,
      },
      cleanup: {
        agentReleased: true,
        terminalClosed: true,
        worktreeRemoved: true,
        namedSessionStopped: true,
        namedSessionDeleted: true,
        tempFilesRemoved: true,
      },
    });
    expect(existsSync(fixture.root)).toBe(false);
  });

  test("rejects every platform or Bun runtime outside the pinned Windows boundary before starting", async () => {
    await expect(
      qualifyWindowsPrompt(qualificationOptions(), {
        platform: "linux",
        architecture: "x64",
        bunVersion: "1.3.14",
      }),
    ).rejects.toThrow("native win32/x64");
    await expect(
      qualifyWindowsPrompt(qualificationOptions(), {
        platform: "win32",
        architecture: "x64",
        bunVersion: "1.3.6",
      }),
    ).rejects.toThrow("requires Bun 1.3.14");
  });
});
