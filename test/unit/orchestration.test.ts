import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeTerminalSession,
  openTerminalSession,
  terminalSessionStatus,
} from "../../src/application/orchestration";
import { readSessionHistory } from "../../src/application/ledger-service";
import {
  sessionEventsPath,
  sessionMetaPath,
  writeSessionMeta,
  type SessionMeta,
} from "../../src/application/session-meta";
import { createSortableId } from "../../src/core/identity";
import { JsonlLedger } from "../../src/core/ledger";
import type { JsonObject } from "../../src/core/ledger/schema";
import { physicalPath, resolveDispatchPaths } from "../../src/core/paths";
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
  type MuxTargetV1,
  type MuxTargetV2,
} from "../../src/ports/mux";

const roots: string[] = [];

interface Fixture {
  readonly root: string;
  readonly paths: ReturnType<typeof resolveDispatchPaths>;
  readonly env: Readonly<Record<string, string>>;
  readonly meta: SessionMeta;
  readonly ledger: JsonlLedger;
}

async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "dispatch-orchestration-"));
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
  return { root, paths, env, meta, ledger };
}

const defaultServerNamespace = {
  session: null,
  socket: "C:\\Users\\operator\\AppData\\Roaming\\herdr\\herdr.sock",
} as const;

function target(
  worktreePath: string,
  generation = "one",
  server: MuxTargetV2["server"] = defaultServerNamespace,
): MuxTargetV2 {
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

function targetV2(
  worktreePath: string,
  generation = "one",
  server: MuxTargetV2["server"] = defaultServerNamespace,
): MuxTargetV2 {
  return target(worktreePath, generation, server);
}

function legacyTarget(
  worktreePath: string,
  generation = "one",
): MuxTargetV1 {
  const current = target(worktreePath, generation);
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

function targetJson(muxTarget: MuxTarget): JsonObject {
  return {
    version: muxTarget.version,
    backend: muxTarget.backend,
    protocol: muxTarget.protocol,
    ...(muxTarget.version === MUX_TARGET_VERSION
      ? {
          server: {
            session: muxTarget.server.session,
            socket: muxTarget.server.socket,
          },
        }
      : {}),
    workspaceId: muxTarget.workspaceId,
    tabId: muxTarget.tabId,
    paneId: muxTarget.paneId,
    terminalId: muxTarget.terminalId,
    canonicalCwd: muxTarget.canonicalCwd,
  };
}

class FakeMux implements MuxPort {
  readonly ensureRequests: MuxEnsureRequest[] = [];
  readonly reconnectTargets: MuxTarget[] = [];
  readonly statusTargets: MuxTarget[] = [];
  readonly closeTargets: MuxTarget[] = [];
  readonly discoveryRequests: MuxDiscoveryRequest[] = [];
  readonly statusByWorkspace = new Map<string, MuxStatus>();

  ensureResult: MuxEnsureResult;
  discovery: MuxDiscovery = { kind: "none" };
  statusResult: MuxStatus;
  closeOutcome: MuxCloseResult["outcome"] = "closed";
  closeError: Error | undefined;
  ensureError: Error | undefined;
  reconnectError: Error | undefined;
  statusError: Error | undefined;
  onEnsure: ((request: MuxEnsureRequest) => void | Promise<void>) | undefined;
  onReconnect:
    | ((target: MuxTarget) => void | Promise<void>)
    | undefined;

  constructor(readonly muxTarget: MuxTarget) {
    this.ensureResult = { target: muxTarget, disposition: "created" };
    this.statusResult = {
      state: "running",
      target: muxTarget,
      focused: true,
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
      server: {
        session: null,
        socket: "C:\\Users\\operator\\AppData\\Roaming\\herdr\\herdr.sock",
      },
      detachedServerDaemon: true,
      liveHandoff: true,
    };
  }

  async discover(request: MuxDiscoveryRequest): Promise<MuxDiscovery> {
    this.discoveryRequests.push(request);
    return this.discovery;
  }

  async ensure(request: MuxEnsureRequest): Promise<MuxEnsureResult> {
    this.ensureRequests.push(request);
    await this.onEnsure?.(request);
    if (this.ensureError) throw this.ensureError;
    return this.ensureResult;
  }

  async status(muxTarget: MuxTarget): Promise<MuxStatus> {
    this.statusTargets.push(muxTarget);
    if (this.statusError) throw this.statusError;
    return this.statusByWorkspace.get(muxTarget.workspaceId) ?? this.statusResult;
  }

  async reconnect(muxTarget: MuxTarget): Promise<MuxStatus> {
    this.reconnectTargets.push(muxTarget);
    await this.onReconnect?.(muxTarget);
    if (this.reconnectError) throw this.reconnectError;
    return {
      state: "running",
      target: muxTarget,
      focused: true,
    };
  }

  async close(muxTarget: MuxTarget): Promise<MuxCloseResult> {
    this.closeTargets.push(muxTarget);
    if (this.closeError) throw this.closeError;
    return { outcome: this.closeOutcome, target: muxTarget };
  }
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

describe("terminal session orchestration", () => {
  test("persists a server-assigned target idempotently without rewriting metadata", async () => {
    const { paths, env, meta } = await fixture();
    const muxTarget = target(meta.worktreePath);
    const mux = new FakeMux(muxTarget);
    const metaBefore = readFileSync(sessionMetaPath(paths, meta.sid), "utf8");

    const opened = await openTerminalSession(meta.sid, mux, { paths, env });
    expect(opened).toMatchObject({
      sid: meta.sid,
      target: muxTarget,
      disposition: "created",
      receipt: "recorded",
      muxStatus: { state: "running", focused: true },
    });
    expect(mux.ensureRequests).toEqual([
      {
        logicalKey: meta.sid,
        canonicalCwd: physicalPath(meta.worktreePath),
        environment: { DISPATCH_SESSION_ID: meta.sid },
      },
    ]);

    mux.ensureResult = { target: muxTarget, disposition: "recovered" };
    const retried = await openTerminalSession(meta.sid, mux, { paths, env });
    expect(retried.receipt).toBe("already_recorded");
    expect(mux.ensureRequests).toHaveLength(1);

    const log = await readSessionHistory(paths, meta.sid);
    expect(log.map((event) => event.kind)).toEqual([
      "session.created",
      "session.opened",
    ]);
    expect(log[1]?.data).toEqual({
      muxTarget: {
        version: MUX_TARGET_VERSION,
        backend: "herdr",
        protocol: 18,
        server: defaultServerNamespace,
        workspaceId: "workspace-one",
        tabId: "tab-one",
        paneId: "pane-one",
        terminalId: "terminal-one",
        canonicalCwd: meta.worktreePath,
      },
      action: "created",
    });
    expect(readFileSync(sessionMetaPath(paths, meta.sid), "utf8")).toBe(
      metaBefore,
    );

    const ensureCount = mux.ensureRequests.length;
    const reconnectCount = mux.reconnectTargets.length;
    const status = await terminalSessionStatus(meta.sid, mux, { paths, env });
    expect(status).toMatchObject({
      dispatchLifecycle: "opened",
      lastSeq: 2,
      target: muxTarget,
      muxStatus: { state: "running", focused: true },
    });
    expect(mux.ensureRequests).toHaveLength(ensureCount);
    expect(mux.reconnectTargets).toHaveLength(reconnectCount);
    expect(mux.statusTargets).toEqual([muxTarget, muxTarget]);
  });

  test("persists and replays the exact V2 server namespace", async () => {
    const { paths, env, meta } = await fixture();
    const muxTarget = targetV2(meta.worktreePath, "v2", {
      session: "dispatch-restart-qualification",
      socket:
        "C:\\Users\\operator\\AppData\\Roaming\\herdr\\dispatch-restart.sock",
    });
    const mux = new FakeMux(muxTarget);

    await openTerminalSession(meta.sid, mux, { paths, env });

    const log = await readSessionHistory(paths, meta.sid);
    expect(log.at(-1)?.data).toEqual({
      muxTarget: targetJson(muxTarget),
      action: "created",
    });
    await expect(
      terminalSessionStatus(meta.sid, mux, { paths, env }),
    ).resolves.toMatchObject({ target: muxTarget });
    expect(mux.statusTargets).toEqual([muxTarget]);
  });

  test("migrates a running legacy V1 receipt to matching V2 discovery before reconnect", async () => {
    const { paths, env, meta, ledger } = await fixture();
    const persisted = legacyTarget(meta.worktreePath, "legacy-open");
    const discovered = targetV2(meta.worktreePath, "legacy-open");
    await ledger.append({
      src: "dsp",
      kind: "session.opened",
      data: {
        muxTarget: targetJson(persisted),
        action: "created",
      },
    });
    const mux = new FakeMux(discovered);
    mux.discovery = { kind: "one", target: discovered };
    mux.statusByWorkspace.set(persisted.workspaceId, {
      state: "running",
      target: persisted,
      focused: false,
    });

    await expect(
      openTerminalSession(meta.sid, mux, { paths, env }),
    ).resolves.toMatchObject({
      target: discovered,
      disposition: "recovered",
      receipt: "recorded",
    });
    expect(mux.ensureRequests).toHaveLength(0);
    expect(mux.discoveryRequests).toHaveLength(1);
    expect(mux.reconnectTargets).toEqual([discovered]);
    const log = await readSessionHistory(paths, meta.sid);
    expect(log.at(-1)?.data).toEqual({
      muxTarget: targetJson(discovered),
      action: "recovered",
    });
  });

  test("requires explicit recovery to migrate a cold-restored legacy V1 target before reconnect", async () => {
    const { paths, env, meta } = await fixture();
    const persisted = legacyTarget(meta.worktreePath, "legacy-restored-open");
    const restored = {
      ...targetV2(meta.worktreePath, "legacy-restored-open"),
      terminalId: "terminal-legacy-restored-open-next",
    };
    const mux = new FakeMux(persisted);
    await openTerminalSession(meta.sid, mux, { paths, env });
    mux.discovery = { kind: "one", target: restored };
    mux.statusError = new MuxError(
      "conflict",
      "Herdr pane.terminal_id no longer matches the persisted mux target.",
      { field: "pane.terminal_id", actual: restored.terminalId },
    );

    await expect(
      openTerminalSession(meta.sid, mux, { paths, env }),
    ).rejects.toThrow("pane.terminal_id");
    expect(mux.discoveryRequests).toHaveLength(0);

    await expect(
      openTerminalSession(meta.sid, mux, {
        paths,
        env,
        allowRestoredGeneration: true,
      }),
    ).resolves.toMatchObject({
      target: restored,
      disposition: "recovered",
      receipt: "recorded",
      recovery: "restored_terminal",
    });
    expect(mux.reconnectTargets.at(-1)).toEqual(restored);
    expect((await readSessionHistory(paths, meta.sid)).at(-1)?.data).toEqual({
      muxTarget: targetJson(restored),
      action: "restored_terminal",
      previousMuxTarget: targetJson(persisted),
    });
  });

  test("requires explicit recovery to migrate and close a cold-restored legacy V1 target", async () => {
    const { paths, env, meta } = await fixture();
    const persisted = legacyTarget(meta.worktreePath, "legacy-restored-close");
    const restored = {
      ...targetV2(meta.worktreePath, "legacy-restored-close"),
      terminalId: "terminal-legacy-restored-close-next",
    };
    const mux = new FakeMux(persisted);
    await openTerminalSession(meta.sid, mux, { paths, env });
    mux.discovery = { kind: "one", target: restored };
    mux.statusError = new MuxError(
      "conflict",
      "Herdr pane.terminal_id no longer matches the persisted mux target.",
      { field: "pane.terminal_id", actual: restored.terminalId },
    );

    await expect(
      closeTerminalSession(meta.sid, mux, { paths, env }),
    ).rejects.toThrow("pane.terminal_id");
    expect(mux.closeTargets).toHaveLength(0);

    await expect(
      closeTerminalSession(meta.sid, mux, {
        paths,
        env,
        allowRestoredGeneration: true,
      }),
    ).resolves.toMatchObject({
      target: restored,
      muxOutcome: "closed",
      receipt: "recorded",
    });
    expect(mux.closeTargets).toEqual([restored]);
    const log = await readSessionHistory(paths, meta.sid);
    expect(log.at(-2)?.data).toEqual({
      muxTarget: targetJson(restored),
      action: "restored_terminal",
      previousMuxTarget: targetJson(persisted),
    });
    expect(log.at(-1)?.kind).toBe("session.closed");
  });

  test("durably records a restored V2 generation before reconnect failure and reuses it on retry", async () => {
    const { paths, env, meta } = await fixture();
    const persisted = targetV2(meta.worktreePath, "restored-open");
    const restored = {
      ...persisted,
      terminalId: "terminal-restored-open-next",
    };
    const mux = new FakeMux(persisted);
    await openTerminalSession(meta.sid, mux, { paths, env });
    mux.discovery = { kind: "one", target: restored };
    mux.statusError = new MuxError(
      "conflict",
      "Herdr pane.terminal_id no longer matches the persisted mux target.",
      { field: "pane.terminal_id", actual: restored.terminalId },
    );

    await expect(
      openTerminalSession(meta.sid, mux, { paths, env }),
    ).rejects.toThrow("pane.terminal_id");
    expect(mux.discoveryRequests).toHaveLength(0);
    expect(mux.reconnectTargets).toEqual([persisted]);
    expect(
      (await readSessionHistory(paths, meta.sid)).filter(
        (event) => event.kind === "session.opened",
      ),
    ).toHaveLength(1);

    mux.reconnectError = new MuxError(
      "unavailable",
      "reconnect interrupted after durable receipt",
    );
    mux.onReconnect = async (reconnected) => {
      const opened = (await readSessionHistory(paths, meta.sid)).filter(
        (event) => event.kind === "session.opened",
      );
      expect(opened).toHaveLength(2);
      expect(opened.at(-1)?.data).toEqual({
        muxTarget: targetJson(reconnected),
        action: "restored_terminal",
        previousMuxTarget: targetJson(persisted),
      });
    };

    await expect(
      openTerminalSession(meta.sid, mux, {
        paths,
        env,
        allowRestoredGeneration: true,
      }),
    ).rejects.toThrow("reconnect interrupted after durable receipt");
    const afterFailure = (await readSessionHistory(paths, meta.sid)).filter(
      (event) => event.kind === "session.opened",
    );
    expect(afterFailure).toHaveLength(2);
    expect(afterFailure.at(-1)?.data).toEqual({
      muxTarget: targetJson(restored),
      action: "restored_terminal",
      previousMuxTarget: targetJson(persisted),
    });

    mux.statusError = undefined;
    mux.statusResult = {
      state: "running",
      target: restored,
      focused: false,
    };
    mux.reconnectError = undefined;
    await expect(
      openTerminalSession(meta.sid, mux, { paths, env }),
    ).resolves.toMatchObject({
      target: restored,
      disposition: "recovered",
      receipt: "already_recorded",
      recovery: null,
    });
    expect(mux.discoveryRequests).toHaveLength(1);
    expect(mux.reconnectTargets.slice(-2)).toEqual([restored, restored]);
    const opened = (await readSessionHistory(paths, meta.sid)).filter(
      (event) => event.kind === "session.opened",
    );
    expect(opened).toHaveLength(2);
    expect(opened.at(-1)?.data).toEqual({
      muxTarget: targetJson(restored),
      action: "restored_terminal",
      previousMuxTarget: targetJson(persisted),
    });
  });

  test("treats identical backend IDs in a different V2 namespace as a different generation", async () => {
    for (const conflictingServer of [
      {
        session: "another-session",
        socket: "C:\\Users\\operator\\AppData\\Roaming\\herdr\\herdr.sock",
      },
      {
        session: null,
        socket:
          "C:\\Users\\operator\\AppData\\Roaming\\herdr\\replacement.sock",
      },
    ] as const) {
      const { paths, env, meta } = await fixture();
      const persisted = targetV2(meta.worktreePath, "same-ids");
      const mux = new FakeMux(persisted);
      await openTerminalSession(meta.sid, mux, { paths, env });
      mux.statusResult = {
        state: "running",
        target: { ...persisted, server: conflictingServer },
        focused: false,
      };

      await expect(
        terminalSessionStatus(meta.sid, mux, { paths, env }),
      ).rejects.toThrow("different target generation");
    }
  });

  test("fails closed when replay sees malformed or extra V1/V2 target fields", async () => {
    const cases: readonly {
      readonly name: string;
      readonly invalidTarget: (worktreePath: string) => JsonObject;
    }[] = [
      {
        name: "V1 extra server namespace",
        invalidTarget: (worktreePath) => ({
          ...legacyTarget(worktreePath),
          server: {
            session: null,
            socket: "C:\\Users\\operator\\AppData\\Roaming\\herdr\\herdr.sock",
          },
        }),
      },
      {
        name: "V2 missing server namespace",
        invalidTarget: (worktreePath) => {
          const { server: _server, ...withoutServer } = targetV2(worktreePath);
          return withoutServer;
        },
      },
      {
        name: "V2 extra server namespace field",
        invalidTarget: (worktreePath) => ({
          ...targetV2(worktreePath),
          server: {
            session: null,
            socket: "C:\\Users\\operator\\AppData\\Roaming\\herdr\\herdr.sock",
            instance: "untrusted",
          },
        }),
      },
      {
        name: "V2 malformed server session",
        invalidTarget: (worktreePath) => ({
          ...targetV2(worktreePath),
          server: {
            session: "",
            socket: "C:\\Users\\operator\\AppData\\Roaming\\herdr\\herdr.sock",
          },
        }),
      },
    ];

    for (const testCase of cases) {
      const { paths, env, meta, ledger } = await fixture();
      await ledger.append({
        src: "dsp",
        kind: "session.opened",
        data: {
          muxTarget: testCase.invalidTarget(meta.worktreePath),
          action: "created",
        },
      });
      const mux = new FakeMux(target(meta.worktreePath));

      await expect(
        terminalSessionStatus(meta.sid, mux, { paths, env }),
      ).rejects.toThrow("Persisted");
      expect(mux.statusTargets, testCase.name).toHaveLength(0);
    }
  });

  test("reconnects the persisted exact target before ambiguous discovery", async () => {
    const { paths, env, meta } = await fixture();
    const persisted = target(meta.worktreePath, "persisted");
    const sibling = {
      ...persisted,
      paneId: "pane-sibling",
      terminalId: "terminal-sibling",
    };
    const mux = new FakeMux(persisted);
    await openTerminalSession(meta.sid, mux, { paths, env });
    mux.discovery = { kind: "ambiguous", candidates: [persisted, sibling] };
    mux.ensureError = new MuxError(
      "ambiguous",
      "ensure must not run for a healthy persisted target",
    );

    const reopened = await openTerminalSession(meta.sid, mux, { paths, env });

    expect(reopened).toMatchObject({
      target: persisted,
      disposition: "recovered",
      receipt: "already_recorded",
      muxStatus: { state: "running", target: persisted, focused: true },
    });
    expect(mux.ensureRequests).toHaveLength(1);
    expect(mux.discoveryRequests).toHaveLength(0);
    expect(mux.statusTargets).toEqual([persisted]);
    expect(mux.reconnectTargets).toEqual([persisted, persisted]);
  });

  test("reconciles an unreceipted ensure result on retry", async () => {
    const { paths, env, meta } = await fixture();
    const muxTarget = target(meta.worktreePath, "recovered");
    const mux = new FakeMux(muxTarget);
    mux.ensureResult = { target: muxTarget, disposition: "recovered" };

    const result = await openTerminalSession(meta.sid, mux, { paths, env });

    expect(result.disposition).toBe("recovered");
    expect(result.receipt).toBe("recorded");
    const status = await terminalSessionStatus(meta.sid, mux, { paths, env });
    expect(status.target).toEqual(muxTarget);
  });

  test("refuses to open a terminal session after Dispatch is terminal", async () => {
    const { paths, env, meta, ledger } = await fixture();
    await ledger.append({
      src: "dsp",
      kind: "session.closed",
      data: { reason: "test" },
    });
    const mux = new FakeMux(target(meta.worktreePath));

    await expect(
      openTerminalSession(meta.sid, mux, { paths, env }),
    ).rejects.toThrow("Cannot open terminal orchestration for closed session");
    expect(mux.ensureRequests).toHaveLength(0);
  });

  test("refuses to open after the worktree removal receipt", async () => {
    const { paths, env, meta, ledger } = await fixture();
    await ledger.append({
      src: "dsp",
      kind: "worktree.removed",
      data: { path: meta.worktreePath },
    });
    const mux = new FakeMux(target(meta.worktreePath));

    await expect(
      openTerminalSession(meta.sid, mux, { paths, env }),
    ).rejects.toThrow("Cannot open terminal orchestration for removed session");
    expect(mux.ensureRequests).toHaveLength(0);
  });

  test("treats committed merge and outcome events as terminal without a final close receipt", async () => {
    for (const kind of ["git.merged", "outcome.recorded"] as const) {
      const { paths, env, meta, ledger } = await fixture();
      await ledger.append({ src: "dsp", kind, data: {} });
      const mux = new FakeMux(target(meta.worktreePath, kind));

      await expect(
        openTerminalSession(meta.sid, mux, { paths, env }),
      ).rejects.toThrow("Cannot open terminal orchestration for closed session");
      expect(mux.ensureRequests).toHaveLength(0);
      expect(mux.statusTargets).toHaveLength(0);
    }
  });

  test("keeps status read-only when no mux receipt exists", async () => {
    const { paths, env, meta } = await fixture();
    const mux = new FakeMux(target(meta.worktreePath));

    const before = readFileSync(sessionEventsPath(paths, meta.sid), "utf8");
    const status = await terminalSessionStatus(meta.sid, mux, { paths, env });

    expect(status).toMatchObject({
      dispatchLifecycle: "created",
      lastSeq: 1,
      target: null,
      muxStatus: { state: "not_recorded" },
    });
    expect(mux.ensureRequests).toHaveLength(0);
    expect(mux.discoveryRequests).toHaveLength(0);
    expect(mux.statusTargets).toHaveLength(0);
    expect(readFileSync(sessionEventsPath(paths, meta.sid), "utf8")).toBe(
      before,
    );
  });

  test("status rejects a backend response for a different target generation", async () => {
    const { paths, env, meta } = await fixture();
    const persisted = target(meta.worktreePath, "persisted-status");
    const different = target(meta.worktreePath, "different-status");
    const mux = new FakeMux(persisted);
    await openTerminalSession(meta.sid, mux, { paths, env });
    mux.statusResult = {
      state: "running",
      target: different,
      focused: false,
    };

    await expect(
      terminalSessionStatus(meta.sid, mux, { paths, env }),
    ).rejects.toThrow("different target generation");
  });

  test("records terminal close only after the backend confirms it", async () => {
    const { paths, env, meta } = await fixture();
    const muxTarget = target(meta.worktreePath);
    const mux = new FakeMux(muxTarget);
    await openTerminalSession(meta.sid, mux, { paths, env });

    mux.closeError = new MuxError("unavailable", "backend unavailable");
    await expect(
      closeTerminalSession(meta.sid, mux, { paths, env }),
    ).rejects.toThrow("backend unavailable");

    expect(
      (await readSessionHistory(paths, meta.sid)).some(
        (event) => event.kind === "session.closed",
      ),
    ).toBeFalse();

    mux.closeError = undefined;
    const closed = await closeTerminalSession(meta.sid, mux, { paths, env });
    expect(closed).toMatchObject({
      target: muxTarget,
      muxOutcome: "closed",
      alreadyClosed: false,
      receipt: "recorded",
    });

    mux.closeOutcome = "already_absent";
    const discoveryCount = mux.discoveryRequests.length;
    const closeCount = mux.closeTargets.length;
    mux.closeError = new MuxError("unavailable", "must not be called");
    const retried = await closeTerminalSession(meta.sid, mux, { paths, env });
    expect(retried).toMatchObject({
      alreadyClosed: true,
      receipt: "already_recorded",
      muxOutcome: "closed",
    });
    expect(mux.discoveryRequests).toHaveLength(discoveryCount);
    expect(mux.closeTargets).toHaveLength(closeCount);
    mux.closeError = undefined;
    const log = await readSessionHistory(paths, meta.sid);
    expect(
      log.filter((event) => event.kind === "session.closed"),
    ).toHaveLength(1);

    mux.statusResult = {
      state: "absent",
      target: muxTarget,
    };
    const status = await terminalSessionStatus(meta.sid, mux, { paths, env });
    expect(status.dispatchLifecycle).toBe("closed");
    expect(status.muxStatus.state).toBe("absent");
  });

  test("discovers and closes an unreceipted target before recording terminal state", async () => {
    const { paths, env, meta } = await fixture();
    const muxTarget = target(meta.worktreePath, "unreceipted");
    const mux = new FakeMux(muxTarget);
    mux.discovery = { kind: "one", target: muxTarget };

    const result = await closeTerminalSession(meta.sid, mux, { paths, env });

    expect(result).toMatchObject({
      target: muxTarget,
      muxOutcome: "closed",
      receipt: "recorded",
    });
    expect(mux.discoveryRequests).toEqual([
      {
        logicalKey: meta.sid,
        canonicalCwd: physicalPath(meta.worktreePath),
      },
    ]);
    expect(mux.closeTargets).toEqual([muxTarget]);
  });

  test("records an adopted target before attempting its backend close", async () => {
    const { paths, env, meta } = await fixture();
    const adopted = target(meta.worktreePath, "adopted");
    const mux = new FakeMux(adopted);
    mux.discovery = { kind: "one", target: adopted };
    mux.closeError = new MuxError("unavailable", "close interrupted");

    await expect(
      closeTerminalSession(meta.sid, mux, { paths, env }),
    ).rejects.toThrow("close interrupted");

    const afterFailure = await readSessionHistory(paths, meta.sid);
    expect(afterFailure.map((event) => event.kind)).toEqual([
      "session.created",
      "session.opened",
    ]);
    expect(afterFailure.at(-1)?.data).toMatchObject({
      muxTarget: adopted,
      action: "recovered",
    });

    mux.closeError = undefined;
    const retried = await closeTerminalSession(meta.sid, mux, { paths, env });
    expect(retried).toMatchObject({
      target: adopted,
      muxOutcome: "closed",
      receipt: "recorded",
    });
    expect(
      (await readSessionHistory(paths, meta.sid)).map((event) => event.kind),
    ).toEqual(["session.created", "session.opened", "session.closed"]);
  });

  test("closes an unreceipted replacement only after proving the persisted generation absent", async () => {
    const { paths, env, meta } = await fixture();
    const persisted = target(meta.worktreePath, "persisted");
    const replacement = target(meta.worktreePath, "replacement");
    const mux = new FakeMux(persisted);
    await openTerminalSession(meta.sid, mux, { paths, env });

    // A was externally closed, open ensured B, and then its ledger append
    // failed. Restore the pre-attempt bytes to model that uncommitted receipt.
    mux.statusByWorkspace.set(persisted.workspaceId, {
      state: "absent",
      target: persisted,
    });
    mux.ensureResult = { target: replacement, disposition: "created" };
    const eventsPath = sessionEventsPath(paths, meta.sid);
    const ledgerBeforeReplacement = readFileSync(eventsPath);
    mux.onEnsure = () => {
      appendFileSync(eventsPath, "{invalid-json}\n");
    };
    let appendFailure: unknown;
    try {
      await openTerminalSession(meta.sid, mux, { paths, env });
    } catch (error) {
      appendFailure = error;
    } finally {
      writeFileSync(eventsPath, ledgerBeforeReplacement);
      mux.onEnsure = undefined;
    }
    expect(appendFailure).toBeInstanceOf(Error);
    expect(
      (await readSessionHistory(paths, meta.sid)).filter(
        (event) => event.kind === "session.opened",
      ),
    ).toHaveLength(1);

    mux.discovery = { kind: "one", target: replacement };

    const result = await closeTerminalSession(meta.sid, mux, { paths, env });

    expect(result).toMatchObject({
      target: replacement,
      muxOutcome: "closed",
      alreadyClosed: false,
      receipt: "recorded",
    });
    expect(mux.statusTargets).toContainEqual(persisted);
    expect(mux.closeTargets).toEqual([replacement]);
    const log = await readSessionHistory(paths, meta.sid);
    expect(log.filter((event) => event.kind === "session.opened")).toHaveLength(
      2,
    );
    expect(log.at(-1)).toMatchObject({
      kind: "session.closed",
      data: { muxTarget: replacement, muxOutcome: "closed" },
    });
  });

  test("fails closed when persisted and discovered mux generations are both present", async () => {
    const { paths, env, meta } = await fixture();
    const persisted = target(meta.worktreePath, "persisted");
    const discovered = target(meta.worktreePath, "discovered");
    const mux = new FakeMux(persisted);
    await openTerminalSession(meta.sid, mux, { paths, env });
    mux.discovery = { kind: "one", target: discovered };
    mux.statusByWorkspace.set(persisted.workspaceId, {
      state: "running",
      target: persisted,
      focused: false,
    });

    await expect(
      closeTerminalSession(meta.sid, mux, { paths, env }),
    ).rejects.toThrow("both present");
    expect(mux.closeTargets).toHaveLength(0);
    expect(
      (await readSessionHistory(paths, meta.sid)).some(
        (event) => event.kind === "session.closed",
      ),
    ).toBeFalse();
  });

  test("does not collapse the same V2 workspace ID across server namespaces during close", async () => {
    const { paths, env, meta } = await fixture();
    const persisted = targetV2(meta.worktreePath, "shared-workspace");
    const discovered = {
      ...persisted,
      server: {
        session: "foreign-session",
        socket:
          "C:\\Users\\operator\\AppData\\Roaming\\herdr\\foreign-session.sock",
      },
    };
    const mux = new FakeMux(persisted);
    await openTerminalSession(meta.sid, mux, { paths, env });
    mux.discovery = { kind: "one", target: discovered };
    mux.statusByWorkspace.set(persisted.workspaceId, {
      state: "running",
      target: persisted,
      focused: false,
    });

    await expect(
      closeTerminalSession(meta.sid, mux, { paths, env }),
    ).rejects.toThrow("both present");
    expect(mux.closeTargets).toHaveLength(0);
  });

  test("migrates a healthy legacy V1 receipt to matching V2 default-server discovery before close", async () => {
    const { paths, env, meta } = await fixture();
    const persisted = legacyTarget(meta.worktreePath, "legacy-default");
    const discovered = targetV2(meta.worktreePath, "legacy-default");
    const mux = new FakeMux(persisted);
    await openTerminalSession(meta.sid, mux, { paths, env });
    mux.discovery = { kind: "one", target: discovered };
    mux.statusByWorkspace.set(persisted.workspaceId, {
      state: "running",
      target: persisted,
      focused: false,
    });

    await expect(
      closeTerminalSession(meta.sid, mux, { paths, env }),
    ).resolves.toMatchObject({
      target: discovered,
      muxOutcome: "closed",
      receipt: "recorded",
    });
    expect(mux.closeTargets).toEqual([discovered]);
    const log = await readSessionHistory(paths, meta.sid);
    expect(log.map((event) => event.kind)).toEqual([
      "session.created",
      "session.opened",
      "session.opened",
      "session.closed",
    ]);
    expect(log[2]?.data).toEqual({
      muxTarget: targetJson(discovered),
      action: "recovered",
    });
  });

  test("records and closes a restored V2 terminal generation", async () => {
    const { paths, env, meta } = await fixture();
    const persisted = targetV2(meta.worktreePath, "restored-close");
    const restored = {
      ...persisted,
      terminalId: "terminal-restored-close-next",
    };
    const mux = new FakeMux(persisted);
    await openTerminalSession(meta.sid, mux, { paths, env });
    mux.discovery = { kind: "one", target: restored };
    mux.statusError = new MuxError(
      "conflict",
      "Herdr pane.terminal_id no longer matches the persisted mux target.",
      { field: "pane.terminal_id", actual: restored.terminalId },
    );

    await expect(
      closeTerminalSession(meta.sid, mux, { paths, env }),
    ).rejects.toThrow("pane.terminal_id");
    expect(mux.closeTargets).toHaveLength(0);
    expect(
      (await readSessionHistory(paths, meta.sid)).filter(
        (event) => event.kind === "session.opened",
      ),
    ).toHaveLength(1);
    mux.statusError = undefined;

    await expect(
      closeTerminalSession(meta.sid, mux, {
        paths,
        env,
        allowRestoredGeneration: true,
      }),
    ).resolves.toMatchObject({
      target: restored,
      muxOutcome: "closed",
      receipt: "recorded",
    });
    expect(mux.closeTargets).toEqual([restored]);
    const log = await readSessionHistory(paths, meta.sid);
    expect(log.map((event) => event.kind)).toEqual([
      "session.created",
      "session.opened",
      "session.opened",
      "session.closed",
    ]);
    expect(log[2]?.data).toEqual({
      muxTarget: targetJson(restored),
      action: "restored_terminal",
      previousMuxTarget: targetJson(persisted),
    });
  });

  test("closes the persisted workspace when ambiguity is only same-workspace panes", async () => {
    const { paths, env, meta } = await fixture();
    const persisted = target(meta.worktreePath, "persisted");
    const sibling = {
      ...persisted,
      paneId: "pane-sibling",
      terminalId: "terminal-sibling",
    };
    const mux = new FakeMux(persisted);
    await openTerminalSession(meta.sid, mux, { paths, env });
    mux.discovery = { kind: "ambiguous", candidates: [persisted, sibling] };

    const closed = await closeTerminalSession(meta.sid, mux, { paths, env });

    expect(closed).toMatchObject({
      target: persisted,
      muxOutcome: "closed",
      receipt: "recorded",
    });
    expect(mux.closeTargets).toEqual([persisted]);
  });

  test("fails closed when ambiguous discovery includes another workspace", async () => {
    const { paths, env, meta } = await fixture();
    const persisted = target(meta.worktreePath, "persisted");
    const competing = target(meta.worktreePath, "competing");
    const mux = new FakeMux(persisted);
    await openTerminalSession(meta.sid, mux, { paths, env });
    mux.discovery = {
      kind: "ambiguous",
      candidates: [persisted, competing],
    };

    await expect(
      closeTerminalSession(meta.sid, mux, { paths, env }),
    ).rejects.toThrow("Multiple mux targets match");
    expect(mux.closeTargets).toHaveLength(0);
  });

  test("merge closure does not suppress a terminal-close receipt", async () => {
    const { paths, env, meta, ledger } = await fixture();
    const persisted = target(meta.worktreePath, "persisted");
    const mux = new FakeMux(persisted);
    await openTerminalSession(meta.sid, mux, { paths, env });
    await ledger.append({
      src: "dsp",
      kind: "session.closed",
      data: { reason: "merged" },
    });

    const closed = await closeTerminalSession(meta.sid, mux, { paths, env });
    expect(closed).toMatchObject({
      alreadyClosed: false,
      receipt: "recorded",
    });
    expect(
      (await readSessionHistory(paths, meta.sid))
        .filter((event) => event.kind === "session.closed")
        .map((event) => event.data.reason),
    ).toEqual(["merged", "terminal-closed"]);

    mux.closeOutcome = "already_absent";
    const retried = await closeTerminalSession(meta.sid, mux, { paths, env });
    expect(retried).toMatchObject({
      alreadyClosed: true,
      receipt: "already_recorded",
    });
    expect(
      (await readSessionHistory(paths, meta.sid)).filter(
        (event) =>
          event.kind === "session.closed" &&
          event.data.reason === "terminal-closed",
      ),
    ).toHaveLength(1);
  });

  test("a prior generation close cannot suppress an adopted generation receipt", async () => {
    const { paths, env, meta, ledger } = await fixture();
    const first = target(meta.worktreePath, "first");
    const adopted = target(meta.worktreePath, "adopted-after-close");
    const mux = new FakeMux(first);
    await openTerminalSession(meta.sid, mux, { paths, env });
    await closeTerminalSession(meta.sid, mux, { paths, env });

    // Models a later close attempt that durably adopted B, closed B, and then
    // crashed before B's terminal-close receipt. On retry B is already absent.
    await ledger.append({
      src: "dsp",
      kind: "session.opened",
      data: {
        muxTarget: targetJson(adopted),
        action: "recovered",
      },
    });
    mux.closeOutcome = "already_absent";

    const retried = await closeTerminalSession(meta.sid, mux, { paths, env });

    expect(retried).toMatchObject({
      target: adopted,
      muxOutcome: "already_absent",
      alreadyClosed: false,
      receipt: "recorded",
    });
    const terminalReceipts = (await readSessionHistory(paths, meta.sid)).filter(
      (event) =>
        event.kind === "session.closed" &&
        event.data.reason === "terminal-closed",
    );
    expect(terminalReceipts).toHaveLength(2);
    expect(terminalReceipts[0]?.data.muxTarget).toEqual(targetJson(first));
    expect(terminalReceipts[1]?.data.muxTarget).toEqual(targetJson(adopted));
  });
});
