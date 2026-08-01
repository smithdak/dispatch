import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { promptTerminalSession } from "../../src/application/orchestration";
import { readSessionHistory } from "../../src/application/ledger-service";
import {
  sessionEventsPath,
  writeSessionMeta,
  type SessionMeta,
} from "../../src/application/session-meta";
import { runCli } from "../../src/cli/run";
import { createSortableId } from "../../src/core/identity";
import { JsonlLedger, type JsonObject } from "../../src/core/ledger";
import { resolveDispatchPaths } from "../../src/core/paths";
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
  type MuxPromptPort,
  type MuxPromptRequest,
  type MuxPromptResult,
  type MuxStatus,
  type MuxTarget,
  type MuxTargetV2,
} from "../../src/ports/mux";

const roots: string[] = [];
const server = {
  session: null,
  socket: "C:\\Users\\operator\\AppData\\Roaming\\herdr\\herdr.sock",
} as const;

interface Fixture {
  readonly paths: ReturnType<typeof resolveDispatchPaths>;
  readonly env: Readonly<Record<string, string>>;
  readonly meta: SessionMeta;
  readonly target: MuxTargetV2;
  readonly mux: FakePromptMux;
}

function targetJson(target: MuxTargetV2): JsonObject {
  return {
    version: target.version,
    backend: target.backend,
    protocol: target.protocol,
    server: { session: target.server.session, socket: target.server.socket },
    workspaceId: target.workspaceId,
    tabId: target.tabId,
    paneId: target.paneId,
    terminalId: target.terminalId,
    canonicalCwd: target.canonicalCwd,
  };
}

class FakePromptMux implements MuxPort, MuxPromptPort {
  readonly statusTargets: MuxTarget[] = [];
  readonly promptRequests: MuxPromptRequest[] = [];
  promptError: Error | undefined;

  constructor(readonly target: MuxTargetV2) {}

  async probe(): Promise<MuxCapabilities> {
    return {
      backend: "herdr",
      executable: "C:\\Herdr\\herdr.exe",
      channel: "preview",
      clientVersion: "test",
      serverVersion: "test",
      protocol: 18,
      server,
      detachedServerDaemon: true,
      liveHandoff: false,
    };
  }

  async discover(_request: MuxDiscoveryRequest): Promise<MuxDiscovery> {
    return { kind: "none" };
  }

  async ensure(_request: MuxEnsureRequest): Promise<MuxEnsureResult> {
    return { target: this.target, disposition: "recovered" };
  }

  async status(target: MuxTarget): Promise<MuxStatus> {
    this.statusTargets.push(target);
    return {
      state: "running",
      target,
      focused: true,
      agentStatus: "idle",
    };
  }

  async reconnect(target: MuxTarget): Promise<MuxStatus> {
    return {
      state: "running",
      target,
      focused: true,
      agentStatus: "idle",
    };
  }

  async close(target: MuxTarget): Promise<MuxCloseResult> {
    return { outcome: "closed", target };
  }

  async prompt(request: MuxPromptRequest): Promise<MuxPromptResult> {
    this.promptRequests.push(request);
    if (this.promptError) throw this.promptError;
    return {
      promptId: request.promptId,
      target: request.target,
      agentStatus: "working",
    };
  }
}

async function createFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "dispatch-cli-prompt-"));
  roots.push(root);
  const env = {
    HOME: root,
    USERPROFILE: root,
    DISPATCH_HOME: join(root, "state"),
  };
  const paths = resolveDispatchPaths(env);
  const sid = createSortableId();
  const repositoryPath = join(root, "repo");
  const worktreePath = join(root, "worktree");
  mkdirSync(repositoryPath, { recursive: true });
  mkdirSync(worktreePath, { recursive: true });
  const meta: SessionMeta = {
    v: 1,
    sid,
    mid: "test-machine",
    repositoryPath,
    worktreePath,
    branch: `dispatch/test-${sid}`,
    baseBranch: "main",
    baseCommit: "a".repeat(40),
    createdAt: "2026-07-31T18:00:00.000Z",
  };
  writeSessionMeta(paths, meta);
  const target: MuxTargetV2 = {
    version: MUX_TARGET_VERSION,
    backend: "herdr",
    protocol: 18,
    server,
    workspaceId: "workspace-cli",
    tabId: "tab-cli",
    paneId: "pane-cli",
    terminalId: "terminal-cli",
    canonicalCwd: worktreePath,
  };
  const ledger = new JsonlLedger({
    eventsPath: sessionEventsPath(paths, sid),
    sessionId: sid,
    machineId: meta.mid,
    syncWrites: false,
  });
  await ledger.append({
    src: "dsp",
    kind: "session.created",
    data: {
      repositoryPath,
      worktreePath,
      branch: meta.branch,
      baseBranch: meta.baseBranch,
      baseCommit: meta.baseCommit,
      createdAt: meta.createdAt,
    },
  });
  await ledger.append({
    src: "dsp",
    kind: "session.opened",
    data: { muxTarget: targetJson(target), action: "created" },
  });
  return { paths, env, meta, target, mux: new FakePromptMux(target) };
}

function promptReceipts(
  history: Awaited<ReturnType<typeof readSessionHistory>>,
) {
  return history.filter(
    (event) => event.kind === "agent.state" && event.data.operation === "prompt",
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  }
});

describe("private prompt CLI", () => {
  test("reads an injected piped stdin body, strips one terminator, and emits no body", async () => {
    const fixture = await createFixture();
    const body = "CLI_STDIN_PRIVATE_BODY_91d3";
    const argv = ["prompt", fixture.meta.sid, "--stdin"];
    const output: string[] = [];
    let reads = 0;

    const exitCode = await runCli(argv, {
      env: fixture.env,
      mux: fixture.mux,
      stdinIsTTY: false,
      readStdin: async () => {
        reads += 1;
        return `${body}\r\n`;
      },
      stdout: (value) => output.push(value),
    });

    expect(exitCode).toBe(0);
    expect(reads).toBe(1);
    expect(argv).not.toContain(body);
    expect(fixture.mux.promptRequests).toHaveLength(1);
    expect(fixture.mux.promptRequests[0]?.text).toBe(body);
    expect(output).toHaveLength(1);
    expect(output[0]).toContain("\tprompt_accepted\t");
    expect(output.join("\n")).not.toContain(body);
    expect(
      readFileSync(
        sessionEventsPath(fixture.paths, fixture.meta.sid),
        "utf8",
      ),
    ).not.toContain(body);
  });

  test("rejects a lone carriage return instead of normalizing it as a line ending", async () => {
    const fixture = await createFixture();
    const body = "CLI_LONE_CR_PRIVATE_BODY_c8a2";
    const errors: string[] = [];
    const errorSpy = spyOn(console, "error").mockImplementation(
      (...values: unknown[]) => errors.push(values.map(String).join(" ")),
    );
    try {
      const exitCode = await runCli(
        ["prompt", fixture.meta.sid, "--stdin"],
        {
          env: fixture.env,
          mux: fixture.mux,
          stdinIsTTY: false,
          readStdin: async () => `${body}\r`,
        },
      );

      expect(exitCode).toBe(1);
      expect(fixture.mux.promptRequests).toHaveLength(0);
      expect(errors.join("\n")).toContain("one line");
      expect(errors.join("\n")).not.toContain(body);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("rejects prompt text in argv and refuses interactive TTY stdin before reading", async () => {
    const fixture = await createFixture();
    const body = "ARGV_BODY_MUST_BE_REJECTED_b1ae";
    const errors: string[] = [];
    const errorSpy = spyOn(console, "error").mockImplementation(
      (...values: unknown[]) => errors.push(values.map(String).join(" ")),
    );
    let reads = 0;
    try {
      const argvExitCode = await runCli(
        ["prompt", fixture.meta.sid, "--stdin", body],
        {
          env: fixture.env,
          mux: fixture.mux,
          stdinIsTTY: false,
          readStdin: async () => {
            reads += 1;
            return "should-not-be-read";
          },
        },
      );
      const ttyExitCode = await runCli(
        ["prompt", fixture.meta.sid, "--stdin"],
        {
          env: fixture.env,
          mux: fixture.mux,
          stdinIsTTY: true,
          readStdin: async () => {
            reads += 1;
            return "should-not-be-read";
          },
        },
      );

      expect(argvExitCode).toBe(2);
      expect(ttyExitCode).toBe(2);
      expect(reads).toBe(0);
      expect(fixture.mux.statusTargets).toHaveLength(0);
      expect(fixture.mux.promptRequests).toHaveLength(0);
      expect(errors.join("\n")).not.toContain(body);
      expect(errors.join("\n")).toContain("must be piped");
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("acknowledges only the exact unresolved prompt without stdin or mux loading", async () => {
    const fixture = await createFixture();
    const unknownBody = "CLI_ACK_ONLY_UNKNOWN_BODY_081c";
    fixture.mux.promptError = new MuxError(
      "outcome_unknown",
      "The pipe closed before acknowledgement.",
    );
    try {
      await promptTerminalSession(
        fixture.meta.sid,
        unknownBody,
        fixture.mux,
        fixture,
      );
    } catch (error) {
      expect(error).toMatchObject({ code: "outcome_unknown" });
    }
    fixture.mux.promptError = undefined;
    const before = promptReceipts(
      await readSessionHistory(fixture.paths, fixture.meta.sid),
    );
    const promptId = before.at(-1)?.data.promptId as string;
    const differentPromptId = createSortableId();
    const invalidPrivateAcknowledgement = "PRIVATE_ACK_VALUE_MUST_NOT_ECHO_513b";
    const output: string[] = [];
    const errors: string[] = [];
    const errorSpy = spyOn(console, "error").mockImplementation(
      (...values: unknown[]) => errors.push(values.map(String).join(" ")),
    );
    let reads = 0;
    try {
      const mismatchExitCode = await runCli(
        ["prompt", fixture.meta.sid, "--acknowledge-unknown", differentPromptId],
        {
          env: fixture.env,
          stdinIsTTY: true,
          readStdin: async () => {
            reads += 1;
            return "should-not-be-read";
          },
          stdout: (value) => output.push(value),
        },
      );
      const invalidExitCode = await runCli(
        [
          "prompt",
          fixture.meta.sid,
          "--acknowledge-unknown",
          invalidPrivateAcknowledgement,
        ],
        {
          env: fixture.env,
          stdinIsTTY: true,
          readStdin: async () => {
            reads += 1;
            return "should-not-be-read";
          },
          stdout: (value) => output.push(value),
        },
      );
      const acknowledgedExitCode = await runCli(
        ["prompt", fixture.meta.sid, "--acknowledge-unknown", promptId],
        {
          env: fixture.env,
          stdinIsTTY: true,
          readStdin: async () => {
            reads += 1;
            return "should-not-be-read";
          },
          stdout: (value) => output.push(value),
        },
      );

      expect(mismatchExitCode).toBe(1);
      expect(invalidExitCode).toBe(1);
      expect(acknowledgedExitCode).toBe(0);
      expect(reads).toBe(0);
      expect(output).toEqual([
        `${fixture.meta.sid}\tprompt_unknown_acknowledged\t${promptId}`,
      ]);
      expect(output.join("\n")).not.toContain(unknownBody);
      expect(errors.join("\n")).not.toContain(unknownBody);
      expect(errors.join("\n")).not.toContain(invalidPrivateAcknowledgement);
    } finally {
      errorSpy.mockRestore();
    }

    const after = promptReceipts(
      await readSessionHistory(fixture.paths, fixture.meta.sid),
    );
    expect(after.map((event) => event.data.state)).toEqual([
      "prompt.intent",
      "prompt.outcome_unknown",
      "prompt.unknown_acknowledged",
    ]);
    expect(after.at(-1)?.data).toMatchObject({
      promptId,
      previousState: "prompt.outcome_unknown",
      acknowledgement: "operator",
    });
  });
});
