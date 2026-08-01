import { describe, expect, test } from "bun:test";

import {
  HERDR_PROTOCOL,
  createHerdrMux,
  type HerdrProcessInvocation,
  type HerdrProcessResult,
  type HerdrProcessRunner,
} from "../../src/adapters/mux-windows/herdr";
import {
  MUX_TARGET_LEGACY_VERSION,
  MUX_TARGET_VERSION,
  MuxError,
  type MuxTargetV1,
  type MuxTargetV2,
} from "../../src/ports/mux";
import { loadMuxPort } from "../../src/adapters/registry";

const executable = "C:\\Program Files\\Herdr\\herdr.exe";
const cwd = "D:\\worktrees\\dispatch\\S1";
const serverNamespace = {
  session: null,
  socket: "C:\\Users\\operator\\AppData\\Roaming\\herdr\\herdr.sock",
} as const;
const namedSession = "dispatch-restart-qualification";
const namedServerNamespace = {
  session: namedSession,
  socket: "C:\\Users\\operator\\AppData\\Roaming\\herdr\\dispatch-restart.sock",
} as const;

type ScriptStep =
  | HerdrProcessResult
  | Error
  | ((invocation: HerdrProcessInvocation) => HerdrProcessResult | Promise<HerdrProcessResult>);

function scripted(...initialSteps: ScriptStep[]): {
  readonly runner: HerdrProcessRunner;
  readonly invocations: HerdrProcessInvocation[];
  readonly remaining: () => number;
} {
  const steps = [...initialSteps];
  const invocations: HerdrProcessInvocation[] = [];
  const runner: HerdrProcessRunner = async (invocation) => {
    invocations.push(invocation);
    const step = steps.shift();
    if (!step) throw new Error(`Unexpected invocation: ${invocation.args.join(" ")}`);
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step(invocation) : step;
  };
  return { runner, invocations, remaining: () => steps.length };
}

function ok(payload: unknown): HerdrProcessResult {
  return { exitCode: 0, stdout: JSON.stringify(payload), stderr: "" };
}

function plainFailure(stderr = "socket unavailable"): HerdrProcessResult {
  return { exitCode: 1, stdout: "", stderr };
}

function domainFailure(code: string, message: string): HerdrProcessResult {
  return {
    exitCode: 1,
    stdout: "",
    stderr: JSON.stringify({ error: { code, message }, id: "cli:test" }),
  };
}

function statusPayload(
  overrides: {
    readonly running?: boolean;
    readonly compatible?: boolean;
    readonly clientProtocol?: number;
    readonly serverProtocol?: number;
    readonly session?: string | null;
    readonly socket?: string;
  } = {},
): unknown {
  return {
    client: {
      version: "0.7.5-preview.2026-07-29-44b3adb12552",
      channel: "preview",
      protocol: overrides.clientProtocol ?? HERDR_PROTOCOL,
      binary: executable,
      session: overrides.session ?? null,
    },
    server: {
      status: overrides.running === false ? "stopped" : "running",
      running: overrides.running ?? true,
      version: "0.7.5-preview.2026-07-29-44b3adb12552",
      protocol: overrides.serverProtocol ?? HERDR_PROTOCOL,
      capabilities: {
        live_handoff: false,
        detached_server_daemon: true,
      },
      compatible: overrides.compatible ?? true,
      socket: overrides.socket ?? serverNamespace.socket,
      session: overrides.session ?? null,
      restart_needed: false,
    },
  };
}

function snapshotPayload(
  workspaces: readonly unknown[] = [],
  tabs: readonly unknown[] = [],
  panes: readonly unknown[] = [],
): unknown {
  return {
    id: "cli:api:snapshot",
    result: {
      type: "session_snapshot",
      snapshot: {
        version: "0.7.5-preview.2026-07-29-44b3adb12552",
        protocol: HERDR_PROTOCOL,
        workspaces,
        tabs,
        panes,
        layouts: [],
        agents: [],
        focused_workspace_id: null,
        focused_tab_id: null,
        focused_pane_id: null,
      },
    },
  };
}

function workspace(
  workspaceId = "wA",
  label = "dispatch:S1",
  focused = false,
): unknown {
  return {
    workspace_id: workspaceId,
    number: 91,
    label,
    focused,
    pane_count: 1,
    tab_count: 1,
    active_tab_id: `${workspaceId}:tA`,
    agent_status: "idle",
  };
}

function tab(workspaceId = "wA", tabId = `${workspaceId}:tA`): unknown {
  return {
    tab_id: tabId,
    workspace_id: workspaceId,
    number: 47,
    label: "main",
    focused: true,
    pane_count: 1,
    agent_status: "idle",
  };
}

function pane(
  workspaceId = "wA",
  tabId = `${workspaceId}:tA`,
  paneId = `${workspaceId}:pA`,
  terminalId = `term_${workspaceId}`,
  paneCwd = cwd,
): unknown {
  return {
    pane_id: paneId,
    terminal_id: terminalId,
    workspace_id: workspaceId,
    tab_id: tabId,
    focused: true,
    agent_status: "idle",
    revision: 3,
    cwd: paneCwd,
  };
}

function target(overrides: Partial<MuxTargetV2> = {}): MuxTargetV2 {
  return {
    version: MUX_TARGET_VERSION,
    backend: "herdr",
    protocol: HERDR_PROTOCOL,
    server: serverNamespace,
    workspaceId: "wA",
    tabId: "wA:tA",
    paneId: "wA:pA",
    terminalId: "term_wA",
    canonicalCwd: cwd,
    ...overrides,
  };
}

function legacyTarget(overrides: Partial<MuxTargetV1> = {}): MuxTargetV1 {
  const current = target();
  return {
    version: MUX_TARGET_LEGACY_VERSION,
    backend: current.backend,
    protocol: current.protocol,
    workspaceId: current.workspaceId,
    tabId: current.tabId,
    paneId: current.paneId,
    terminalId: current.terminalId,
    canonicalCwd: current.canonicalCwd,
    ...overrides,
  };
}

function liveSnapshot(focused = false): unknown {
  return snapshotPayload(
    [workspace("wA", "dispatch:S1", focused)],
    [tab()],
    [pane()],
  );
}

async function muxError(
  operation: Promise<unknown>,
  code: MuxError["code"],
): Promise<MuxError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(MuxError);
    expect((error as MuxError).code).toBe(code);
    return error as MuxError;
  }
  throw new Error(`Expected MuxError(${code}).`);
}

describe("Herdr Windows mux adapter", () => {
  test("probes protocol 18 through an absolute executable argv without a shell", async () => {
    const script = scripted(ok(statusPayload()));
    const mux = createHerdrMux({ executable, runner: script.runner });

    await expect(mux.probe()).resolves.toEqual({
      backend: "herdr",
      executable,
      channel: "preview",
      clientVersion: "0.7.5-preview.2026-07-29-44b3adb12552",
      serverVersion: "0.7.5-preview.2026-07-29-44b3adb12552",
      protocol: HERDR_PROTOCOL,
      server: serverNamespace,
      detachedServerDaemon: true,
      liveHandoff: false,
    });
    expect(script.invocations).toEqual([
      {
        executable,
        args: ["--session", "default", "status", "--json"],
        shell: false,
      },
    ]);
  });

  test("prefixes every named-session invocation and propagates that namespace into the V2 create receipt", async () => {
    const script = scripted(
      ok(
        statusPayload({
          session: namedServerNamespace.session,
          socket: namedServerNamespace.socket,
        }),
      ),
      ok(snapshotPayload()),
      ok({
        id: "cli:workspace:create",
        result: {
          type: "workspace_created",
          workspace: workspace(),
          tab: tab(),
          root_pane: pane(),
        },
      }),
    );
    const mux = createHerdrMux({
      executable,
      session: namedSession,
      runner: script.runner,
    });

    await expect(
      mux.ensure({ logicalKey: "S1", canonicalCwd: cwd }),
    ).resolves.toEqual({
      target: target({ server: namedServerNamespace }),
      disposition: "created",
    });
    expect(
      script.invocations.map((invocation) => invocation.args.slice(0, 2)),
    ).toEqual([
      ["--session", namedSession],
      ["--session", namedSession],
      ["--session", namedSession],
    ]);
  });

  test("rejects configured and live Herdr session mismatches", async () => {
    const noInvocation = scripted(ok(statusPayload()));
    const namedMux = createHerdrMux({
      executable,
      session: namedSession,
      runner: noInvocation.runner,
    });
    const configuredError = await muxError(namedMux.status(target()), "conflict");
    expect(configuredError.details.field).toBe("server.session");
    expect(noInvocation.invocations).toHaveLength(0);

    const wrongLiveSession = scripted(
      ok(
        statusPayload({
          session: "another-session",
          socket: namedServerNamespace.socket,
        }),
      ),
    );
    const liveError = await muxError(
      createHerdrMux({
        executable,
        session: namedSession,
        runner: wrongLiveSession.runner,
      }).probe(),
      "conflict",
    );
    expect(liveError.details).toMatchObject({
      expectedSession: namedSession,
      clientSession: "another-session",
      serverSession: "another-session",
    });
  });

  test("rejects an exact live socket mismatch before inspecting target IDs", async () => {
    const liveSocket =
      "C:\\Users\\operator\\AppData\\Roaming\\herdr\\replacement.sock";
    const script = scripted(
      ok(statusPayload({ socket: liveSocket })),
      ok(snapshotPayload()),
    );
    const error = await muxError(
      createHerdrMux({ executable, runner: script.runner }).status(target()),
      "conflict",
    );

    expect(error.details).toMatchObject({
      field: "server.socket",
      actual: liveSocket,
    });
    expect(script.invocations).toHaveLength(2);
  });

  test("accepts a legacy V1 target only on the default server namespace", async () => {
    const defaultScript = scripted(ok(statusPayload()), ok(liveSnapshot()));
    await expect(
      createHerdrMux({ executable, runner: defaultScript.runner }).status(
        legacyTarget(),
      ),
    ).resolves.toMatchObject({ state: "running", target: legacyTarget() });

    const namedScript = scripted(ok(statusPayload()));
    const error = await muxError(
      createHerdrMux({
        executable,
        session: namedSession,
        runner: namedScript.runner,
      }).status(legacyTarget()),
      "conflict",
    );
    expect(error.details).toMatchObject({
      field: "server.session",
      actual: namedSession,
    });
    expect(namedScript.invocations).toHaveLength(0);

    const mutationScript = scripted(ok(statusPayload()), ok(liveSnapshot()));
    await muxError(
      createHerdrMux({ executable, runner: mutationScript.runner }).close(
        legacyTarget(),
      ),
      "incompatible",
    );
    expect(
      mutationScript.invocations.filter(
        (invocation) =>
          invocation.args[2] === "workspace" && invocation.args[3] === "close",
      ),
    ).toHaveLength(0);
  });

  test("rejects relative launcher provenance and incompatible servers", async () => {
    expect(() => createHerdrMux({ executable: "herdr.exe" })).toThrow(
      "must be an absolute path",
    );

    const script = scripted(ok(statusPayload({ serverProtocol: 19 })));
    const mux = createHerdrMux({ executable, runner: script.runner });
    await muxError(mux.probe(), "incompatible");
  });

  test("classifies unstructured transport failures as unavailable", async () => {
    const script = scripted(plainFailure());
    const mux = createHerdrMux({ executable, runner: script.runner });
    await muxError(mux.probe(), "unavailable");
  });

  test("discovers one server-assigned target by label and canonical Windows cwd", async () => {
    const script = scripted(
      ok(statusPayload()),
      ok(
        snapshotPayload(
          [workspace()],
          [tab()],
          [pane("wA", "wA:tA", "wA:pA", "term_wA", "d:/WORKTREES/dispatch/S1")],
        ),
      ),
    );
    const mux = createHerdrMux({ executable, runner: script.runner });

    await expect(mux.discover({ logicalKey: "S1", canonicalCwd: cwd })).resolves.toEqual({
      kind: "one",
      target: target(),
    });
    expect(script.invocations[1]?.args).toEqual([
      "--session",
      "default",
      "api",
      "snapshot",
    ]);
  });

  test("returns none or all candidates without using display numbers as identity", async () => {
    const none = scripted(ok(statusPayload()), ok(snapshotPayload()));
    const noneMux = createHerdrMux({ executable, runner: none.runner });
    await expect(
      noneMux.discover({ logicalKey: "S1", canonicalCwd: cwd }),
    ).resolves.toEqual({ kind: "none" });

    const ambiguous = scripted(
      ok(statusPayload()),
      ok(
        snapshotPayload(
          [workspace("wA"), workspace("wB")],
          [tab("wA"), tab("wB")],
          [pane("wA"), pane("wB")],
        ),
      ),
    );
    const ambiguousMux = createHerdrMux({
      executable,
      runner: ambiguous.runner,
    });
    const result = await ambiguousMux.discover({
      logicalKey: "S1",
      canonicalCwd: cwd,
    });
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.candidates.map((candidate) => candidate.workspaceId)).toEqual([
        "wA",
        "wB",
      ]);
    }
  });

  test("recovers an existing target without issuing create", async () => {
    const script = scripted(ok(statusPayload()), ok(liveSnapshot()));
    const mux = createHerdrMux({ executable, runner: script.runner });

    await expect(
      mux.ensure({ logicalKey: "S1", canonicalCwd: cwd }),
    ).resolves.toEqual({ target: target(), disposition: "recovered" });
    expect(script.invocations).toHaveLength(2);
  });

  test("creates without focus and persists only opaque receipt identities", async () => {
    const script = scripted(
      ok(statusPayload()),
      ok(snapshotPayload()),
      ok({
        id: "cli:workspace:create",
        result: {
          type: "workspace_created",
          workspace: workspace(),
          tab: tab(),
          root_pane: pane("wA", "wA:tA", "wA:pA", "term_wA", `${cwd}\\`),
        },
      }),
    );
    const mux = createHerdrMux({ executable, runner: script.runner });

    await expect(
      mux.ensure({
        logicalKey: "S1",
        canonicalCwd: cwd,
        environment: { ZED: "last", ALPHA: "first" },
      }),
    ).resolves.toEqual({ target: target(), disposition: "created" });
    expect(script.invocations[2]).toEqual({
      executable,
      shell: false,
      args: [
        "--session",
        "default",
        "workspace",
        "create",
        "--cwd",
        cwd,
        "--label",
        "dispatch:S1",
        "--env",
        "ALPHA=first",
        "--env",
        "DISPATCH_SESSION_ID=S1",
        "--env",
        "ZED=last",
        "--no-focus",
      ],
    });
  });

  test("reconciles instead of trusting a create receipt without its exact label", async () => {
    const receiptWorkspace = workspace() as Record<string, unknown>;
    delete receiptWorkspace.label;
    const script = scripted(
      ok(statusPayload()),
      ok(snapshotPayload()),
      ok({
        id: "cli:workspace:create",
        result: {
          type: "workspace_created",
          workspace: receiptWorkspace,
          tab: tab(),
          root_pane: pane(),
        },
      }),
      ok(statusPayload()),
      ok(liveSnapshot()),
    );
    const mux = createHerdrMux({ executable, runner: script.runner });

    await expect(
      mux.ensure({ logicalKey: "S1", canonicalCwd: cwd }),
    ).resolves.toEqual({ target: target(), disposition: "recovered" });
    expect(script.invocations.map((invocation) => invocation.args.slice(2, 4))).toEqual([
      ["status", "--json"],
      ["api", "snapshot"],
      ["workspace", "create"],
      ["status", "--json"],
      ["api", "snapshot"],
    ]);
  });

  test("reconciles instead of trusting a create receipt without its exact cwd", async () => {
    const receiptPane = pane() as Record<string, unknown>;
    delete receiptPane.cwd;
    const script = scripted(
      ok(statusPayload()),
      ok(snapshotPayload()),
      ok({
        id: "cli:workspace:create",
        result: {
          type: "workspace_created",
          workspace: workspace(),
          tab: tab(),
          root_pane: receiptPane,
        },
      }),
      ok(statusPayload()),
      ok(liveSnapshot()),
    );
    const mux = createHerdrMux({ executable, runner: script.runner });

    await expect(
      mux.ensure({ logicalKey: "S1", canonicalCwd: cwd }),
    ).resolves.toEqual({ target: target(), disposition: "recovered" });
  });

  test("reconciles a lost create receipt before considering a retry", async () => {
    const script = scripted(
      ok(statusPayload()),
      ok(snapshotPayload()),
      plainFailure("connection reset after write"),
      ok(statusPayload()),
      ok(liveSnapshot()),
    );
    const mux = createHerdrMux({ executable, runner: script.runner });

    await expect(
      mux.ensure({ logicalKey: "S1", canonicalCwd: cwd }),
    ).resolves.toEqual({ target: target(), disposition: "recovered" });
    expect(
      script.invocations.filter((call) => call.args[2] === "workspace"),
    ).toHaveLength(1);
  });

  test("retries create only after a fresh snapshot proves no match", async () => {
    const script = scripted(
      ok(statusPayload()),
      ok(snapshotPayload()),
      plainFailure("connection reset"),
      ok(statusPayload()),
      ok(snapshotPayload()),
      ok({
        id: "cli:workspace:create",
        result: {
          type: "workspace_created",
          workspace: workspace(),
          tab: tab(),
          root_pane: pane(),
        },
      }),
    );
    const mux = createHerdrMux({ executable, runner: script.runner });

    await expect(
      mux.ensure({ logicalKey: "S1", canonicalCwd: cwd }),
    ).resolves.toMatchObject({ disposition: "created" });
    expect(script.invocations.map((call) => call.args.slice(2, 4))).toEqual([
      ["status", "--json"],
      ["api", "snapshot"],
      ["workspace", "create"],
      ["status", "--json"],
      ["api", "snapshot"],
      ["workspace", "create"],
    ]);
  });

  test("fails closed on ambiguous recovery and unreconciled mutation outcomes", async () => {
    const ambiguous = scripted(
      ok(statusPayload()),
      ok(snapshotPayload()),
      plainFailure("connection reset"),
      ok(statusPayload()),
      ok(
        snapshotPayload(
          [workspace("wA"), workspace("wB")],
          [tab("wA"), tab("wB")],
          [pane("wA"), pane("wB")],
        ),
      ),
    );
    await muxError(
      createHerdrMux({ executable, runner: ambiguous.runner }).ensure({
        logicalKey: "S1",
        canonicalCwd: cwd,
      }),
      "ambiguous",
    );

    const unknown = scripted(
      ok(statusPayload()),
      ok(snapshotPayload()),
      plainFailure("connection reset"),
      plainFailure("snapshot socket unavailable"),
    );
    await muxError(
      createHerdrMux({ executable, runner: unknown.runner }).ensure({
        logicalKey: "S1",
        canonicalCwd: cwd,
      }),
      "outcome_unknown",
    );
  });

  test("status distinguishes absent from generation or cwd conflicts", async () => {
    const absent = scripted(ok(statusPayload()), ok(snapshotPayload()));
    await expect(
      createHerdrMux({ executable, runner: absent.runner }).status(target()),
    ).resolves.toEqual({ state: "absent", target: target() });

    const conflict = scripted(
      ok(statusPayload()),
      ok(
        snapshotPayload(
          [workspace()],
          [tab()],
          [pane("wA", "wA:tA", "wA:pA", "term_replaced")],
        ),
      ),
    );
    await muxError(
      createHerdrMux({ executable, runner: conflict.runner }).status(target()),
      "conflict",
    );
  });

  test("reconnect focuses only a preflight-verified workspace and re-snapshots", async () => {
    const script = scripted(
      ok(statusPayload()),
      ok(liveSnapshot(false)),
      ok({ id: "cli:workspace:focus", result: { type: "workspace_focused" } }),
      ok(statusPayload()),
      ok(liveSnapshot(true)),
    );
    const mux = createHerdrMux({ executable, runner: script.runner });

    await expect(mux.reconnect(target())).resolves.toMatchObject({
      state: "running",
      focused: true,
    });
    expect(script.invocations[2]).toEqual({
      executable,
      args: ["--session", "default", "workspace", "focus", "wA"],
      shell: false,
    });
  });

  test("reconnect accepts a lost receipt only when snapshot proves focus", async () => {
    const script = scripted(
      ok(statusPayload()),
      ok(liveSnapshot(false)),
      plainFailure("connection reset"),
      ok(statusPayload()),
      ok(liveSnapshot(true)),
    );
    await expect(
      createHerdrMux({ executable, runner: script.runner }).reconnect(target()),
    ).resolves.toMatchObject({ state: "running", focused: true });
  });

  test("close verifies identity, reconciles absence, and safely retries once", async () => {
    const script = scripted(
      ok(statusPayload()),
      ok(liveSnapshot()),
      plainFailure("connection reset"),
      ok(statusPayload()),
      ok(liveSnapshot()),
      ok({ id: "cli:workspace:close", result: { type: "workspace_closed" } }),
      ok(statusPayload()),
      ok(snapshotPayload()),
    );
    const mux = createHerdrMux({ executable, runner: script.runner });

    await expect(mux.close(target())).resolves.toEqual({
      outcome: "closed",
      target: target(),
    });
    expect(
      script.invocations.filter(
        (call) => call.args[2] === "workspace" && call.args[3] === "close",
      ),
    ).toHaveLength(2);
  });

  test("close is idempotent when the exact workspace is already absent", async () => {
    const script = scripted(ok(statusPayload()), ok(snapshotPayload()));
    const mux = createHerdrMux({ executable, runner: script.runner });
    await expect(mux.close(target())).resolves.toEqual({
      outcome: "already_absent",
      target: target(),
    });
    expect(script.remaining()).toBe(0);
  });

  test("does not mutate when preflight identity validation conflicts", async () => {
    const script = scripted(
      ok(statusPayload()),
      ok(
        snapshotPayload(
          [workspace()],
          [tab()],
          [pane("wA", "wA:tA", "wA:pA", "term_foreign")],
        ),
      ),
    );
    const mux = createHerdrMux({ executable, runner: script.runner });
    await muxError(mux.close(target()), "conflict");
    expect(script.invocations).toHaveLength(2);
  });

  test("rejects malformed success envelopes instead of guessing identities", async () => {
    const script = scripted(
      ok(statusPayload()),
      ok({ id: "cli:api:snapshot", result: { type: "session_snapshot" } }),
    );
    await muxError(
      createHerdrMux({ executable, runner: script.runner }).discover({
        logicalKey: "S1",
        canonicalCwd: cwd,
      }),
      "invalid_response",
    );
  });

  test("does not implement prompting or shell-text execution", () => {
    const mux = createHerdrMux({
      executable,
      runner: async () => {
        throw new Error("not called");
      },
    });
    expect("prompt" in mux).toBe(false);
    expect("run" in mux).toBe(false);
  });

  test("preserves structured Herdr domain failures", async () => {
    const script = scripted(domainFailure("protocol_incompatible", "upgrade required"));
    await muxError(
      createHerdrMux({ executable, runner: script.runner }).probe(),
      "incompatible",
    );
  });

  test("registry rejects every target outside the qualified win32/x64 boundary", async () => {
    await muxError(loadMuxPort({}, "win32", "arm64"), "unavailable");
    await muxError(loadMuxPort({}, "linux", "x64"), "unavailable");
  });
});
