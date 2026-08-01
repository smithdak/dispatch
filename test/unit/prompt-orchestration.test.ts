import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acknowledgeUnknownPrompt,
  closeTerminalSession,
  openTerminalSession,
  PRIVATE_PROMPT_MAX_UTF8_BYTES,
  promptTerminalSession,
} from "../../src/application/orchestration";
import { readSessionHistory } from "../../src/application/ledger-service";
import {
  sessionEventsPath,
  writeSessionMeta,
  type SessionMeta,
} from "../../src/application/session-meta";
import { createSortableId } from "../../src/core/identity";
import {
  JsonlLedger,
  withExclusiveFileLock,
  type JsonObject,
} from "../../src/core/ledger";
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
  type MuxTargetV1,
  type MuxTargetV2,
} from "../../src/ports/mux";

const roots: string[] = [];

interface Fixture {
  readonly paths: ReturnType<typeof resolveDispatchPaths>;
  readonly env: Readonly<Record<string, string>>;
  readonly meta: SessionMeta;
  readonly ledger: JsonlLedger;
  readonly target: MuxTargetV2;
  readonly mux: FakePromptMux;
}

const server = {
  session: null,
  socket: "C:\\Users\\operator\\AppData\\Roaming\\herdr\\herdr.sock",
} as const;

function v2Target(worktreePath: string, generation = "one"): MuxTargetV2 {
  return {
    version: MUX_TARGET_VERSION,
    backend: "herdr",
    protocol: 18,
    server,
    workspaceId: `workspace-${generation}`,
    tabId: `tab-${generation}`,
    paneId: `pane-${generation}`,
    terminalId: `terminal-${generation}`,
    canonicalCwd: worktreePath,
  };
}

function v1Target(worktreePath: string): MuxTargetV1 {
  const current = v2Target(worktreePath, "legacy");
  return {
    version: 1,
    backend: current.backend,
    protocol: current.protocol,
    workspaceId: current.workspaceId,
    tabId: current.tabId,
    paneId: current.paneId,
    terminalId: current.terminalId,
    canonicalCwd: current.canonicalCwd,
  };
}

function targetJson(target: MuxTarget): JsonObject {
  return {
    version: target.version,
    backend: target.backend,
    protocol: target.protocol,
    ...(target.version === MUX_TARGET_VERSION
      ? { server: { session: target.server.session, socket: target.server.socket } }
      : {}),
    workspaceId: target.workspaceId,
    tabId: target.tabId,
    paneId: target.paneId,
    terminalId: target.terminalId,
    canonicalCwd: target.canonicalCwd,
  };
}

class FakePromptMux implements MuxPort, MuxPromptPort {
  readonly discoveryRequests: MuxDiscoveryRequest[] = [];
  readonly ensureRequests: MuxEnsureRequest[] = [];
  readonly statusTargets: MuxTarget[] = [];
  readonly reconnectTargets: MuxTarget[] = [];
  readonly closeTargets: MuxTarget[] = [];
  readonly promptRequests: MuxPromptRequest[] = [];

  statusResult: MuxStatus;
  promptError: Error | undefined;
  onPrompt:
    | ((request: MuxPromptRequest) => void | Promise<void>)
    | undefined;

  constructor(readonly target: MuxTargetV2) {
    this.statusResult = {
      state: "running",
      target,
      focused: true,
      agentStatus: "idle",
    };
  }

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

  async discover(request: MuxDiscoveryRequest): Promise<MuxDiscovery> {
    this.discoveryRequests.push(request);
    return { kind: "none" };
  }

  async ensure(request: MuxEnsureRequest): Promise<MuxEnsureResult> {
    this.ensureRequests.push(request);
    return { target: this.target, disposition: "recovered" };
  }

  async status(target: MuxTarget): Promise<MuxStatus> {
    this.statusTargets.push(target);
    return this.statusResult;
  }

  async reconnect(target: MuxTarget): Promise<MuxStatus> {
    this.reconnectTargets.push(target);
    return { state: "running", target, focused: true, agentStatus: "idle" };
  }

  async close(target: MuxTarget): Promise<MuxCloseResult> {
    this.closeTargets.push(target);
    return { outcome: "closed", target };
  }

  async prompt(request: MuxPromptRequest): Promise<MuxPromptResult> {
    this.promptRequests.push(request);
    await this.onPrompt?.(request);
    if (this.promptError) throw this.promptError;
    return {
      promptId: request.promptId,
      target: request.target,
      agentStatus: "working",
    };
  }
}

async function baseFixture(): Promise<{
  readonly paths: ReturnType<typeof resolveDispatchPaths>;
  readonly env: Readonly<Record<string, string>>;
  readonly meta: SessionMeta;
  readonly ledger: JsonlLedger;
}> {
  const root = mkdtempSync(join(tmpdir(), "dispatch-prompt-"));
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
  return { paths, env, meta, ledger };
}

async function openedFixture(): Promise<Fixture> {
  const base = await baseFixture();
  const target = v2Target(base.meta.worktreePath);
  await base.ledger.append({
    src: "dsp",
    kind: "session.opened",
    data: { muxTarget: targetJson(target), action: "created" },
  });
  return { ...base, target, mux: new FakePromptMux(target) };
}

function promptReceipts(
  history: Awaited<ReturnType<typeof readSessionHistory>>,
) {
  return history.filter(
    (event) => event.kind === "agent.state" && event.data.operation === "prompt",
  );
}

async function errorWithCode(
  operation: Promise<unknown>,
  code: string,
): Promise<Error & { readonly code: string; readonly details?: unknown }> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ code });
  return caught as Error & { readonly code: string; readonly details?: unknown };
}

async function leaveUnknown(fixture: Fixture, text: string): Promise<string> {
  fixture.mux.promptError = new MuxError(
    "outcome_unknown",
    "The pipe closed before the acknowledgement was observed.",
  );
  const error = await errorWithCode(
    promptTerminalSession(fixture.meta.sid, text, fixture.mux, fixture),
    "outcome_unknown",
  );
  fixture.mux.promptError = undefined;
  return (error.details as { readonly promptId: string }).promptId;
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

describe("private prompt orchestration", () => {
  test("durably records intent before transport and then records acceptance without the body", async () => {
    const fixture = await openedFixture();
    const body = "PROMPT_BODY_MUST_REMAIN_EPHEMERAL_7f54";
    let observedDurableIntent = false;

    fixture.mux.onPrompt = async (request) => {
      const duringTransport = promptReceipts(
        await readSessionHistory(fixture.paths, fixture.meta.sid),
      );
      expect(duringTransport.map((event) => event.data.state)).toEqual([
        "prompt.intent",
      ]);
      expect(duringTransport[0]?.data).toMatchObject({
        promptId: request.promptId,
        transport: "herdr_named_pipe",
        preflightAgentStatus: "idle",
      });
      expect(
        readFileSync(
          sessionEventsPath(fixture.paths, fixture.meta.sid),
          "utf8",
        ),
      ).not.toContain(body);
      observedDurableIntent = true;
    };

    const result = await promptTerminalSession(
      fixture.meta.sid,
      body,
      fixture.mux,
      fixture,
    );

    expect(observedDurableIntent).toBe(true);
    expect(fixture.mux.promptRequests).toHaveLength(1);
    expect(fixture.mux.promptRequests[0]).toMatchObject({
      promptId: result.promptId,
      target: fixture.target,
      text: body,
    });
    expect(result).toMatchObject({
      sid: fixture.meta.sid,
      target: fixture.target,
      agentStatus: "working",
      receipt: "accepted",
    });
    const history = await readSessionHistory(fixture.paths, fixture.meta.sid);
    expect(promptReceipts(history).map((event) => event.data.state)).toEqual([
      "prompt.intent",
      "prompt.accepted",
    ]);
    expect(
      readFileSync(
        sessionEventsPath(fixture.paths, fixture.meta.sid),
        "utf8",
      ),
    ).not.toContain(body);
    expect(JSON.stringify(result)).not.toContain(body);
    expect(JSON.stringify(history)).not.toContain(body);
  });

  test("releases the lifecycle lock while the prompt transport is in flight", async () => {
    const fixture = await openedFixture();
    let hookCaptured = false;
    fixture.mux.onPrompt = async () => {
      await withExclusiveFileLock(
        `${sessionEventsPath(fixture.paths, fixture.meta.sid)}.lifecycle`,
        async () => {
          await fixture.ledger.append({
            src: "hook",
            kind: "agent.state",
            data: { state: "qualification-hook-observed" },
          });
          hookCaptured = true;
        },
        { timeoutMs: 100 },
      );
    };

    await expect(
      promptTerminalSession(
        fixture.meta.sid,
        "lifecycle-lock-release-check",
        fixture.mux,
        fixture,
      ),
    ).resolves.toMatchObject({ receipt: "accepted" });

    expect(hookCaptured).toBe(true);
    expect((await readSessionHistory(fixture.paths, fixture.meta.sid)).map(
      (event) => [event.src, event.kind, event.data.state],
    )).toEqual([
      ["dsp", "session.created", undefined],
      ["dsp", "session.opened", undefined],
      ["dsp", "agent.state", "prompt.intent"],
      ["hook", "agent.state", "qualification-hook-observed"],
      ["dsp", "agent.state", "prompt.accepted"],
    ]);
  });

  test("records an unknown outcome and blocks an unacknowledged retry", async () => {
    const fixture = await openedFixture();
    const firstBody = "unknown-delivery-body-441f";
    const promptId = await leaveUnknown(fixture, firstBody);

    const history = await readSessionHistory(fixture.paths, fixture.meta.sid);
    expect(promptReceipts(history).map((event) => event.data.state)).toEqual([
      "prompt.intent",
      "prompt.outcome_unknown",
    ]);
    expect(promptReceipts(history)[1]?.data).toMatchObject({
      promptId,
      errorCode: "outcome_unknown",
    });
    expect(
      readFileSync(
        sessionEventsPath(fixture.paths, fixture.meta.sid),
        "utf8",
      ),
    ).not.toContain(firstBody);

    await errorWithCode(
      promptTerminalSession(
        fixture.meta.sid,
        "must-not-be-submitted",
        fixture.mux,
        fixture,
      ),
      "session.prompt_outcome_unresolved",
    );
    expect(fixture.mux.promptRequests).toHaveLength(1);
  });

  test("requires the exact prompt ID and supports acknowledgement without submission", async () => {
    const fixture = await openedFixture();
    const promptId = await leaveUnknown(fixture, "acknowledge-this-body");
    const differentPromptId = createSortableId();

    await errorWithCode(
      acknowledgeUnknownPrompt(fixture.meta.sid, differentPromptId, fixture),
      "session.prompt_acknowledgement_mismatch",
    );
    expect(fixture.mux.promptRequests).toHaveLength(1);

    const acknowledgement = await acknowledgeUnknownPrompt(
      fixture.meta.sid,
      promptId,
      fixture,
    );
    expect(acknowledgement).toMatchObject({
      sid: fixture.meta.sid,
      promptId,
      previousState: "prompt.outcome_unknown",
      receipt: "acknowledged",
    });
    expect(fixture.mux.promptRequests).toHaveLength(1);

    const retry = await promptTerminalSession(
      fixture.meta.sid,
      "safe-after-acknowledgement",
      fixture.mux,
      fixture,
    );
    expect(retry.receipt).toBe("accepted");
    expect(promptReceipts(
      await readSessionHistory(fixture.paths, fixture.meta.sid),
    ).map((event) => [event.data.promptId, event.data.state])).toEqual([
      [promptId, "prompt.intent"],
      [promptId, "prompt.outcome_unknown"],
      [promptId, "prompt.unknown_acknowledged"],
      [retry.promptId, "prompt.intent"],
      [retry.promptId, "prompt.accepted"],
    ]);
  });

  test("can acknowledge the exact unknown receipt atomically with a new prompt", async () => {
    const fixture = await openedFixture();
    const promptId = await leaveUnknown(fixture, "first-uncertain-body");

    const retry = await promptTerminalSession(
      fixture.meta.sid,
      "second-body",
      fixture.mux,
      { ...fixture, acknowledgeUnknownPromptId: promptId },
    );

    const receipts = promptReceipts(
      await readSessionHistory(fixture.paths, fixture.meta.sid),
    );
    expect(receipts.map((event) => [event.data.promptId, event.data.state])).toEqual([
      [promptId, "prompt.intent"],
      [promptId, "prompt.outcome_unknown"],
      [promptId, "prompt.unknown_acknowledged"],
      [retry.promptId, "prompt.intent"],
      [retry.promptId, "prompt.accepted"],
    ]);
    expect(receipts[2]?.data).toMatchObject({
      previousState: "prompt.outcome_unknown",
      acknowledgement: "operator",
    });
  });

  test("records a known rejection as terminal and permits retry without acknowledgement", async () => {
    const fixture = await openedFixture();
    fixture.mux.promptError = new MuxError(
      "conflict",
      "Herdr rejected the resolved target.",
    );

    await errorWithCode(
      promptTerminalSession(
        fixture.meta.sid,
        "known-rejection-body",
        fixture.mux,
        fixture,
      ),
      "conflict",
    );
    fixture.mux.promptError = undefined;
    const retry = await promptTerminalSession(
      fixture.meta.sid,
      "retry-after-known-rejection",
      fixture.mux,
      fixture,
    );

    expect(retry.receipt).toBe("accepted");
    expect(fixture.mux.promptRequests).toHaveLength(2);
    expect(promptReceipts(
      await readSessionHistory(fixture.paths, fixture.meta.sid),
    ).map((event) => event.data.state)).toEqual([
      "prompt.intent",
      "prompt.rejected",
      "prompt.intent",
      "prompt.accepted",
    ]);
  });

  test("blocks terminal open and close while a prompt receipt is unresolved", async () => {
    const fixture = await openedFixture();
    const promptId = await leaveUnknown(fixture, "lifecycle-barrier-body");
    const statusCalls = fixture.mux.statusTargets.length;

    const closeError = await errorWithCode(
      closeTerminalSession(fixture.meta.sid, fixture.mux, fixture),
      "session.prompt_outcome_unresolved",
    );
    const openError = await errorWithCode(
      openTerminalSession(fixture.meta.sid, fixture.mux, fixture),
      "session.prompt_outcome_unresolved",
    );

    expect(closeError.message).toContain(promptId);
    expect(openError.message).toContain(promptId);
    expect(fixture.mux.statusTargets).toHaveLength(statusCalls);
    expect(fixture.mux.discoveryRequests).toHaveLength(0);
    expect(fixture.mux.ensureRequests).toHaveLength(0);
    expect(fixture.mux.reconnectTargets).toHaveLength(0);
    expect(fixture.mux.closeTargets).toHaveLength(0);
  });

  test("submits only to a running idle V2 target", async () => {
    const fixture = await openedFixture();
    const notReady: MuxStatus[] = [
      { state: "absent", target: fixture.target },
      { state: "running", target: fixture.target, focused: true },
      {
        state: "running",
        target: fixture.target,
        focused: true,
        agentStatus: "working",
      },
      {
        state: "running",
        target: fixture.target,
        focused: true,
        agentStatus: "blocked",
      },
      {
        state: "running",
        target: fixture.target,
        focused: true,
        agentStatus: "done",
      },
      {
        state: "running",
        target: fixture.target,
        focused: true,
        agentStatus: "unknown",
      },
    ];

    for (const status of notReady) {
      fixture.mux.statusResult = status;
      await errorWithCode(
        promptTerminalSession(
          fixture.meta.sid,
          `not-ready-${status.state}-${status.state === "running" ? status.agentStatus : "absent"}`,
          fixture.mux,
          fixture,
        ),
        "session.prompt_not_ready",
      );
    }
    expect(fixture.mux.promptRequests).toHaveLength(0);
    expect(promptReceipts(
      await readSessionHistory(fixture.paths, fixture.meta.sid),
    )).toHaveLength(0);

    const legacy = await baseFixture();
    const target = v1Target(legacy.meta.worktreePath);
    await legacy.ledger.append({
      src: "dsp",
      kind: "session.opened",
      data: { muxTarget: targetJson(target), action: "created" },
    });
    const legacyMux = new FakePromptMux(v2Target(legacy.meta.worktreePath));
    await errorWithCode(
      promptTerminalSession(
        legacy.meta.sid,
        "legacy-target-must-not-receive-this",
        legacyMux,
        legacy,
      ),
      "session.prompt_target_legacy",
    );
    expect(legacyMux.statusTargets).toHaveLength(0);
    expect(legacyMux.promptRequests).toHaveLength(0);
  });

  test("enforces non-empty one-line control-free UTF-8 byte bounds", async () => {
    const fixture = await openedFixture();
    const invalid = [
      "   ",
      "line one\nline two",
      "line one\rline two",
      "tab\tseparated",
      "escape\u001bsequence",
      "delete\u007fcharacter",
      "c1\u0085control",
      "unicode\u2028line separator",
      "unicode\u2029paragraph separator",
      "a".repeat(PRIVATE_PROMPT_MAX_UTF8_BYTES + 1),
    ];

    for (const body of invalid) {
      await errorWithCode(
        promptTerminalSession(fixture.meta.sid, body, fixture.mux, fixture),
        "session.prompt_invalid",
      );
    }
    expect(fixture.mux.statusTargets).toHaveLength(0);
    expect(fixture.mux.promptRequests).toHaveLength(0);

    const exactUtf8Limit = "é".repeat(PRIVATE_PROMPT_MAX_UTF8_BYTES / 2);
    expect(new TextEncoder().encode(exactUtf8Limit).byteLength).toBe(
      PRIVATE_PROMPT_MAX_UTF8_BYTES,
    );
    await expect(
      promptTerminalSession(
        fixture.meta.sid,
        exactUtf8Limit,
        fixture.mux,
        fixture,
      ),
    ).resolves.toMatchObject({ receipt: "accepted" });
    expect(fixture.mux.promptRequests[0]?.text).toBe(exactUtf8Limit);
  });
});
