import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  parseWindowsMuxQualificationOptions,
  qualifyWindowsMux,
  type ProcessInvocation,
  type ProcessResult,
} from "../../scripts/qualify-windows-mux";

const sid = "01kywyrp5e-2y5qv64427d1npck";
const binary = "C:\\Dispatch\\dsp.exe";
const herdr = "C:\\Program Files\\Herdr\\herdr.exe";
const cwd = "C:\\Dispatch Worktrees\\qualification";
const herdrSocket = "C:\\Users\\operator\\AppData\\Roaming\\herdr\\herdr.sock";

function target(
  generation: "one" | "two",
  server = { session: null as string | null, socket: herdrSocket },
) {
  return {
    version: 2,
    backend: "herdr",
    protocol: 18,
    server,
    workspaceId: `w-${generation}`,
    tabId: `t-${generation}`,
    paneId: `p-${generation}`,
    terminalId: `term-${generation}`,
    canonicalCwd: cwd,
  } as const;
}

function running(muxTarget = target("one"), focused = true) {
  return { state: "running", target: muxTarget, focused } as const;
}

function doctor(
  server = { session: null as string | null, socket: herdrSocket },
) {
  return {
    readyForStage0: true,
    readyForStage1: true,
    herdrServer: server,
    checks: [
      { name: "platform", status: "ok", detail: "win32/x64" },
      { name: "herdr", status: "ok", detail: "protocol 18" },
    ],
  };
}

function herdrStatus(
  session: string | null = null,
  socket = herdrSocket,
) {
  return {
    client: { session },
    server: { running: true, session, socket },
  };
}

function snapshot(focusedWorkspaceId: string | null, workspaceIds: readonly string[]) {
  return {
    id: "cli:api:snapshot",
    result: {
      type: "session_snapshot",
      snapshot: {
        focused_workspace_id: focusedWorkspaceId,
        workspaces: workspaceIds.map((workspaceId) => ({ workspace_id: workspaceId })),
      },
    },
  };
}

function status(
  muxTarget: ReturnType<typeof target> | null,
  lastSeq: number,
  state: "created" | "opened" | "closed" = muxTarget ? "opened" : "created",
  muxState: "running" | "absent" | "not_recorded" = muxTarget ? "running" : "not_recorded",
) {
  return {
    sid,
    dispatchLifecycle: state,
    lastSeq,
    target: muxTarget,
    muxStatus:
      muxState === "not_recorded"
        ? { state: "not_recorded" }
        : muxState === "absent"
          ? { state: "absent", target: muxTarget }
          : running(muxTarget!),
  };
}

function open(
  muxTarget: ReturnType<typeof target>,
  disposition: "created" | "recovered",
  receipt: "recorded" | "already_recorded" = "recorded",
) {
  return {
    sid,
    target: muxTarget,
    disposition,
    receipt,
    recovery: null,
    muxStatus: running(muxTarget),
    projectionWarnings: [],
  };
}

function ok(value: unknown): ProcessResult {
  return { exitCode: 0, stdout: JSON.stringify(value), stderr: "" };
}

class ScriptedRunner {
  readonly invocations: ProcessInvocation[] = [];
  readonly #results: ProcessResult[];

  constructor(results: readonly ProcessResult[]) {
    this.#results = [...results];
  }

  run = async (invocation: ProcessInvocation): Promise<ProcessResult> => {
    this.invocations.push(invocation);
    const result = this.#results.shift();
    if (!result) throw new Error(`Unexpected invocation: ${invocation.args.join(" ")}`);
    return result;
  };

  done(): void {
    expect(this.#results).toHaveLength(0);
  }
}

function dependencies(script: ScriptedRunner) {
  return {
    runner: script.run,
    platform: "win32" as const,
    architecture: "x64",
    which: () => herdr,
    executableExists: () => true,
    sha256: () => "a".repeat(64),
    now: () => new Date("2026-07-31T23:00:00.000Z"),
  };
}

describe("native Windows mux qualification harness", () => {
  test("requires explicit binary and SID while keeping destructive flags off by default", () => {
    expect(() => parseWindowsMuxQualificationOptions([])).toThrow("--binary is required");
    expect(() =>
      parseWindowsMuxQualificationOptions(["--binary", "dist/dsp.exe"]),
    ).toThrow("--sid is required");
    expect(
      parseWindowsMuxQualificationOptions([
        "--binary",
        "dist/dsp.exe",
        "--sid",
        sid,
        "--output",
        "evidence/result.json",
        "--herdr-session",
        "dispatch-restart-proof",
      ]),
    ).toEqual({
      binary: resolve("dist/dsp.exe"),
      sid,
      exerciseExternalClose: false,
      close: false,
      output: resolve("evidence/result.json"),
      herdrSession: "dispatch-restart-proof",
    });
  });

  test("rejects duplicate, unknown, invalid SID, and shell-shim options", async () => {
    expect(() =>
      parseWindowsMuxQualificationOptions([
        "--binary",
        "a.exe",
        "--binary",
        "b.exe",
        "--sid",
        sid,
      ]),
    ).toThrow("only once");
    expect(() =>
      parseWindowsMuxQualificationOptions([
        "--binary",
        "a.exe",
        "--sid",
        "not-a-sid",
      ]),
    ).toThrow("canonical Dispatch session ID");
    expect(() => parseWindowsMuxQualificationOptions(["--wat"])).toThrow(
      "Unknown option",
    );

    await expect(
      qualifyWindowsMux(
        {
          binary: "C:\\Dispatch\\dsp.cmd",
          sid,
          exerciseExternalClose: false,
          close: false,
        },
        {
          platform: "win32",
          architecture: "x64",
          executableExists: () => true,
        },
      ),
    ).rejects.toThrow("native executable");

    await expect(
      qualifyWindowsMux(
        {
          binary,
          herdr,
          sid,
          exerciseExternalClose: false,
          close: false,
          output: binary.toLowerCase(),
        },
        {
          platform: "win32",
          architecture: "x64",
          executableExists: () => true,
        },
      ),
    ).rejects.toThrow("must not overwrite");
  });

  test("uses separate shell-free processes and leaves the target open by default", async () => {
    const selectedSession = "dispatch-restart-proof";
    const selectedServer = {
      session: selectedSession,
      socket: "C:\\Users\\operator\\AppData\\Roaming\\herdr\\sessions\\dispatch-restart-proof\\herdr.sock",
    };
    const one = target("one", selectedServer);
    const script = new ScriptedRunner([
      ok(doctor(selectedServer)),
      ok(herdrStatus(selectedSession, selectedServer.socket)),
      ok(snapshot("operator-workspace", ["operator-workspace"])),
      ok(status(null, 2)),
      ok(open(one, "created")),
      ok(status(one, 3)),
      ok(open(one, "recovered", "already_recorded")),
      ok(status(one, 3)),
      ok(snapshot(one.workspaceId, ["operator-workspace", one.workspaceId])),
      ok({ id: "focus", result: { type: "workspace_info" } }),
      ok(snapshot("operator-workspace", ["operator-workspace", one.workspaceId])),
    ]);

    const evidence = await qualifyWindowsMux(
      {
        binary,
        herdr,
        herdrSession: selectedSession,
        sid,
        exerciseExternalClose: false,
        close: false,
      },
      dependencies(script),
    );
    script.done();

    expect(evidence.verdict).toBe("pass");
    expect(evidence.profile).toBe("open_status");
    expect(evidence.completeLifecycle).toBeFalse();
    expect(evidence.inputs).toMatchObject({
      binary: { path: binary, sha256: "a".repeat(64) },
      herdr: { path: herdr, sha256: "a".repeat(64) },
      herdrSession: selectedSession,
    });
    expect(evidence.focusRestoration).toEqual({
      attempted: true,
      outcome: "restored",
      workspaceId: "operator-workspace",
      resultType: "workspace_info",
    });
    expect(script.invocations.every((invocation) => invocation.shell === false)).toBeTrue();
    expect(script.invocations.every((invocation) =>
      invocation.executable === binary || invocation.executable === herdr
    )).toBeTrue();
    expect(
      script.invocations
        .filter((invocation) => invocation.executable === binary)
        .every(
          (invocation) =>
            invocation.env?.DISPATCH_HERDR_BIN === herdr &&
            invocation.env.DISPATCH_HERDR_SESSION === selectedSession,
        ),
    ).toBeTrue();
    expect(
      script.invocations
        .filter((invocation) => invocation.executable === herdr)
        .every(
          (invocation) =>
            invocation.args[0] === "--session" &&
            invocation.args[1] === selectedSession,
        ),
    ).toBeTrue();
    expect(script.invocations.filter((invocation) =>
      invocation.executable === binary && invocation.args[0] === "open"
    )).toHaveLength(2);
    expect(script.invocations.some((invocation) =>
      invocation.args[0] === "close" ||
      (invocation.executable === herdr &&
        invocation.args[2] === "workspace" &&
        invocation.args[3] === "close")
    )).toBeFalse();
  });

  test("fails before open when compiled and direct probes resolve different sessions", async () => {
    const selectedSession = "dispatch-restart-proof";
    const selectedSocket =
      "C:\\Users\\operator\\AppData\\Roaming\\herdr\\sessions\\dispatch-restart-proof\\herdr.sock";
    const script = new ScriptedRunner([
      ok(doctor()),
      ok(herdrStatus(selectedSession, selectedSocket)),
    ]);

    await expect(
      qualifyWindowsMux(
        {
          binary,
          herdr,
          herdrSession: selectedSession,
          sid,
          exerciseExternalClose: false,
          close: false,
        },
        dependencies(script),
      ),
    ).rejects.toThrow("did not resolve the explicitly selected Herdr server namespace");
    script.done();
    expect(
      script.invocations.some(
        (invocation) =>
          invocation.executable === binary && invocation.args[0] === "open",
      ),
    ).toBeFalse();
  });

  test("qualifies external-close recovery as a new generation and explicit terminal close", async () => {
    const one = target("one");
    const two = target("two");
    const script = new ScriptedRunner([
      ok(doctor()),
      ok(herdrStatus()),
      ok(snapshot("operator-workspace", ["operator-workspace"])),
      ok(status(null, 2)),
      ok(open(one, "created")),
      ok(status(one, 3)),
      ok(open(one, "recovered", "already_recorded")),
      ok(status(one, 3)),
      ok({ id: "close", result: { type: "ok" } }),
      ok(status(one, 3, "opened", "absent")),
      ok(open(two, "created")),
      ok(status(two, 4)),
      ok({
        sid,
        target: two,
        muxOutcome: "closed",
        alreadyClosed: false,
        receipt: "recorded",
        projectionWarnings: [],
      }),
      ok(status(two, 5, "closed", "absent")),
      ok(snapshot("operator-workspace", ["operator-workspace"])),
    ]);

    const evidence = await qualifyWindowsMux(
      { binary, herdr, sid, exerciseExternalClose: true, close: true },
      dependencies(script),
    );
    script.done();

    expect(evidence.verdict).toBe("pass");
    expect(evidence.profile).toBe("full_lifecycle");
    expect(evidence.completeLifecycle).toBeTrue();
    expect(evidence.observations.recoveryOpen).toMatchObject({ target: two });
    expect(evidence.observations.closedStatus).toMatchObject({
      dispatchLifecycle: "closed",
      target: two,
      muxStatus: { state: "absent", target: two },
    });
    expect(script.invocations.some((invocation) =>
      invocation.executable === herdr &&
      invocation.args.join("\0") ===
        ["--session", "default", "workspace", "close", one.workspaceId].join("\0")
    )).toBeTrue();
    expect(script.invocations.some((invocation) =>
      invocation.executable === binary &&
      invocation.args.join("\0") === ["close", sid, "--json"].join("\0")
    )).toBeTrue();
  });

  test("accepts focus absence only when close removed the exact entry workspace", async () => {
    const one = target("one");
    const script = new ScriptedRunner([
      ok(doctor()),
      ok(herdrStatus()),
      ok(snapshot(one.workspaceId, [one.workspaceId])),
      ok(status(null, 2)),
      ok(open(one, "created")),
      ok(status(one, 3)),
      ok(open(one, "recovered", "already_recorded")),
      ok(status(one, 3)),
      ok({
        sid,
        target: one,
        muxOutcome: "closed",
        alreadyClosed: false,
        receipt: "recorded",
        projectionWarnings: [],
      }),
      ok(status(one, 4, "closed", "absent")),
      ok(snapshot(null, [])),
    ]);

    const evidence = await qualifyWindowsMux(
      { binary, herdr, sid, exerciseExternalClose: false, close: true },
      dependencies(script),
    );
    script.done();
    expect(evidence.verdict).toBe("pass");
    expect(evidence.focusRestoration).toEqual({
      attempted: false,
      outcome: "workspace_absent",
      workspaceId: one.workspaceId,
    });
  });

  test("writes failed evidence after strict JSON or exit validation", async () => {
    const script = new ScriptedRunner([
      { exitCode: 0, stdout: "not-json", stderr: "" },
    ]);
    let written: unknown;
    await expect(
      qualifyWindowsMux(
        {
          binary,
          herdr,
          sid,
          exerciseExternalClose: false,
          close: false,
          output: "C:\\evidence\\mux.json",
        },
        {
          ...dependencies(script),
          writeEvidence: (_path, evidence) => {
            written = evidence;
          },
        },
      ),
    ).rejects.toThrow("did not return exactly one valid JSON value");
    expect(written).toMatchObject({ verdict: "fail" });
  });

  test("fails qualification evidence when operator focus is not restored", async () => {
    const one = target("one");
    const script = new ScriptedRunner([
      ok(doctor()),
      ok(herdrStatus()),
      ok(snapshot("operator-workspace", ["operator-workspace"])),
      ok(status(null, 2)),
      ok(open(one, "created")),
      ok(status(one, 3)),
      ok(open(one, "recovered", "already_recorded")),
      ok(status(one, 3)),
      ok(snapshot(one.workspaceId, ["operator-workspace", one.workspaceId])),
      ok({ id: "focus", result: { type: "workspace_info" } }),
      ok(snapshot(one.workspaceId, ["operator-workspace", one.workspaceId])),
    ]);
    let written: unknown;

    await expect(
      qualifyWindowsMux(
        {
          binary,
          herdr,
          sid,
          exerciseExternalClose: false,
          close: false,
          output: "C:\\evidence\\focus.json",
        },
        {
          ...dependencies(script),
          writeEvidence: (_path, evidence) => {
            written = evidence;
          },
        },
      ),
    ).rejects.toThrow("Operator focus was not restored");
    script.done();
    expect(written).toMatchObject({
      verdict: "fail",
      focusRestoration: {
        attempted: true,
        outcome: "unconfirmed",
        workspaceId: "operator-workspace",
      },
    });
  });

  test("full lifecycle rejects a pre-opened session", async () => {
    const one = target("one");
    const script = new ScriptedRunner([
      ok(doctor()),
      ok(herdrStatus()),
      ok(snapshot("operator-workspace", ["operator-workspace", one.workspaceId])),
      ok(status(one, 3)),
      ok(snapshot("operator-workspace", ["operator-workspace", one.workspaceId])),
    ]);
    let written: unknown;

    await expect(
      qualifyWindowsMux(
        {
          binary,
          herdr,
          sid,
          exerciseExternalClose: true,
          close: true,
          output: "C:\\evidence\\pre-opened.json",
        },
        {
          ...dependencies(script),
          writeEvidence: (_path, evidence) => {
            written = evidence;
          },
        },
      ),
    ).rejects.toThrow("fresh created/not_recorded");
    script.done();
    expect(written).toMatchObject({
      verdict: "fail",
      profile: "full_lifecycle",
      completeLifecycle: false,
    });
  });

  test("rejects target receipts from a protocol other than 18", async () => {
    const wrongProtocol = { ...target("one"), protocol: 19 };
    const script = new ScriptedRunner([
      ok(doctor()),
      ok(herdrStatus()),
      ok(snapshot("operator-workspace", ["operator-workspace"])),
      ok(status(null, 2)),
      ok({
        ...open(target("one"), "created"),
        target: wrongProtocol,
        muxStatus: running(wrongProtocol as ReturnType<typeof target>),
      }),
      ok(snapshot("operator-workspace", ["operator-workspace"])),
    ]);

    await expect(
      qualifyWindowsMux(
        { binary, herdr, sid, exerciseExternalClose: false, close: false },
        dependencies(script),
      ),
    ).rejects.toThrow("protocol must equal 18");
    script.done();
  });
});
