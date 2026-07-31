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
import { physicalPath, resolveDispatchPaths } from "../../src/core/paths";
import {
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

function target(worktreePath: string, generation = "one"): MuxTarget {
  return {
    version: 1,
    backend: "herdr",
    protocol: 18,
    workspaceId: `workspace-${generation}`,
    tabId: `tab-${generation}`,
    paneId: `pane-${generation}`,
    terminalId: `terminal-${generation}`,
    canonicalCwd: worktreePath,
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
  onEnsure: ((request: MuxEnsureRequest) => void | Promise<void>) | undefined;

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
    return this.statusByWorkspace.get(muxTarget.workspaceId) ?? this.statusResult;
  }

  async reconnect(muxTarget: MuxTarget): Promise<MuxStatus> {
    this.reconnectTargets.push(muxTarget);
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
        version: 1,
        backend: "herdr",
        protocol: 18,
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
      data: { muxTarget: { ...adopted }, action: "recovered" },
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
    expect(terminalReceipts[0]?.data.muxTarget).toEqual({ ...first });
    expect(terminalReceipts[1]?.data.muxTarget).toEqual({ ...adopted });
  });
});
