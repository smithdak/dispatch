import { describe, expect, test } from "bun:test";

import {
  parseWindowsRestartQualificationOptions,
  qualifyWindowsRestart,
} from "../../scripts/qualify-windows-restart";
import type {
  MuxTarget,
  ProcessInvocation,
  ProcessResult,
} from "../../scripts/qualify-windows-mux";

const sid = "01kywyrp5e-2y5qv64427d1npck";
const binary = "C:\\Dispatch\\dsp.exe";
const herdr = "C:\\Program Files\\Herdr\\herdr.exe";
const sessionPrefix = "dispatch-restart-proof";
const sessionNonce = "b".repeat(32);
const session = `${sessionPrefix}-${sessionNonce}`;
const defaultSocket =
  "C:\\Users\\operator\\AppData\\Roaming\\herdr\\herdr.sock";
const namedSocket =
  `C:\\Users\\operator\\AppData\\Roaming\\herdr\\sessions\\${session}\\herdr.sock`;

function ok(value: unknown = ""): ProcessResult {
  return {
    exitCode: 0,
    stdout: typeof value === "string" ? value : JSON.stringify(value),
    stderr: "",
  };
}

class RestartEnvironment {
  readonly invocations: ProcessInvocation[] = [];
  readonly starts: Array<{ herdr: string; session: string }> = [];
  namedExists: boolean;
  namedRunning: boolean;
  defaultSnapshotCount = 0;
  dispatchLifecycle: "created" | "opened" | "closed" = "created";
  lastSeq = 2;
  pendingRestoredGeneration = false;
  initialStatusFailureInjected = false;
  recoveryOpenFailureInjected = false;

  target: MuxTarget = {
    version: 2,
    backend: "herdr",
    protocol: 18,
    server: { session, socket: namedSocket },
    workspaceId: "workspace-proof",
    tabId: "tab-proof",
    paneId: "pane-proof",
    terminalId: "terminal-proof",
    canonicalCwd: "C:\\Dispatch Worktrees\\qualification",
  };

  constructor(
    options: {
      readonly preexistingNamed?: boolean;
      readonly driftDefaultAfterBaseline?: boolean;
      readonly failAfterInitialOpenWithTerminalConflict?: boolean;
      readonly failRecoveryOpenOnce?: boolean;
    } = {},
  ) {
    this.namedExists = options.preexistingNamed ?? false;
    this.namedRunning = options.preexistingNamed ?? false;
    this.driftDefaultAfterBaseline = options.driftDefaultAfterBaseline ?? false;
    this.failAfterInitialOpenWithTerminalConflict =
      options.failAfterInitialOpenWithTerminalConflict ?? false;
    this.failRecoveryOpenOnce = options.failRecoveryOpenOnce ?? false;
  }

  readonly driftDefaultAfterBaseline: boolean;
  readonly failAfterInitialOpenWithTerminalConflict: boolean;
  readonly failRecoveryOpenOnce: boolean;

  startServer = async (actualHerdr: string, actualSession: string): Promise<void> => {
    this.starts.push({ herdr: actualHerdr, session: actualSession });
    if (actualHerdr !== herdr || actualSession !== session) {
      throw new Error("starter received the wrong executable or session");
    }
    if (this.namedRunning) throw new Error("starter replaced a running named server");
    this.namedExists = true;
    this.namedRunning = true;
    if (this.dispatchLifecycle === "opened") {
      this.target = {
        ...this.target,
        terminalId: `${this.target.terminalId}-next`,
      };
      this.pendingRestoredGeneration = true;
    }
  };

  run = async (invocation: ProcessInvocation): Promise<ProcessResult> => {
    this.invocations.push(invocation);
    if (invocation.shell !== false) throw new Error("qualification used a shell");
    if (invocation.executable === herdr) return this.runHerdr(invocation.args);
    if (invocation.executable === binary) return this.runDispatch(invocation);
    throw new Error(`unexpected executable: ${invocation.executable}`);
  };

  private runHerdr(args: readonly string[]): ProcessResult {
    if (args.join("\0") === ["session", "list", "--json"].join("\0")) {
      return ok({
        sessions: [
          { name: "default", running: true },
          ...(this.namedExists
            ? [{ name: session, running: this.namedRunning }]
            : []),
        ],
      });
    }
    if (
      args.join("\0") ===
      ["session", "delete", session, "--json"].join("\0")
    ) {
      if (!this.namedExists || this.namedRunning) {
        return { exitCode: 1, stdout: "", stderr: "session is not stopped" };
      }
      this.namedExists = false;
      return ok({ deleted: true });
    }
    if (args[0] !== "--session" || args.length < 3) {
      throw new Error(`Herdr command was not explicitly session scoped: ${args.join(" ")}`);
    }
    const selectedSession = args[1]!;
    const command = args.slice(2);
    if (selectedSession === "default") return this.runDefaultHerdr(command);
    if (selectedSession !== session) {
      throw new Error(`Herdr command selected unexpected session ${selectedSession}`);
    }
    return this.runNamedHerdr(command);
  }

  private runDefaultHerdr(args: readonly string[]): ProcessResult {
    if (args.join("\0") === ["status", "--json"].join("\0")) {
      return ok(this.herdrStatus(null, defaultSocket));
    }
    if (args.join("\0") === ["api", "snapshot"].join("\0")) {
      this.defaultSnapshotCount += 1;
      const drifted =
        this.driftDefaultAfterBaseline && this.defaultSnapshotCount > 1;
      return ok(
        this.snapshot({
          focusedWorkspaceId: "operator-workspace",
          workspaceIds: drifted
            ? ["operator-workspace", "unexpected-workspace"]
            : ["operator-workspace"],
          includeShape: true,
        }),
      );
    }
    throw new Error(`unexpected default Herdr command: ${args.join(" ")}`);
  }

  private runNamedHerdr(args: readonly string[]): ProcessResult {
    if (args.join("\0") === ["status", "--json"].join("\0")) {
      return this.namedRunning
        ? ok(this.herdrStatus(session, namedSocket))
        : { exitCode: 1, stdout: "", stderr: "server is stopped" };
    }
    if (args.join("\0") === ["server", "stop"].join("\0")) {
      if (!this.namedRunning) {
        return { exitCode: 1, stdout: "", stderr: "server is stopped" };
      }
      this.namedRunning = false;
      return ok();
    }
    if (args.join("\0") === ["api", "snapshot"].join("\0")) {
      if (!this.namedRunning) {
        return { exitCode: 1, stdout: "", stderr: "server is stopped" };
      }
      return ok(
        this.snapshot({
          focusedWorkspaceId: null,
          workspaceIds:
            this.dispatchLifecycle === "created" ? [] : [this.target.workspaceId],
          includeShape: false,
        }),
      );
    }
    if (args[0] === "pane" && ["run", "wait-output"].includes(args[1]!)) {
      if (!this.namedRunning) {
        return { exitCode: 1, stdout: "", stderr: "server is stopped" };
      }
      return ok();
    }
    throw new Error(`unexpected named Herdr command: ${args.join(" ")}`);
  }

  private runDispatch(invocation: ProcessInvocation): ProcessResult {
    if (
      invocation.env?.DISPATCH_HERDR_BIN !== herdr ||
      invocation.env.DISPATCH_HERDR_SESSION !== session
    ) {
      throw new Error("Dispatch command was not bound to the isolated Herdr session");
    }
    const args = invocation.args;
    if (args.join("\0") === ["doctor", "--stage1", "--json"].join("\0")) {
      return ok({
        readyForStage0: true,
        readyForStage1: true,
        herdrServer: { session, socket: namedSocket },
        checks: [],
      });
    }
    if (args.join("\0") === ["status", sid, "--json"].join("\0")) {
      if (this.dispatchLifecycle === "created") {
        return ok({
          sid,
          dispatchLifecycle: "created",
          lastSeq: this.lastSeq,
          target: null,
          muxStatus: { state: "not_recorded" },
        });
      }
      if (this.dispatchLifecycle === "closed") {
        return ok({
          sid,
          dispatchLifecycle: "closed",
          lastSeq: this.lastSeq,
          target: this.target,
          muxStatus: { state: "absent", target: this.target },
        });
      }
      if (
        this.failAfterInitialOpenWithTerminalConflict &&
        !this.initialStatusFailureInjected &&
        this.lastSeq === 3
      ) {
        this.initialStatusFailureInjected = true;
        this.target = {
          ...this.target,
          terminalId: `${this.target.terminalId}-foreign`,
        };
        return {
          exitCode: 1,
          stdout: "",
          stderr: "simulated status failure after initial open",
        };
      }
      return ok({
        sid,
        dispatchLifecycle: "opened",
        lastSeq: this.lastSeq,
        target: this.target,
        muxStatus: { state: "running", target: this.target, focused: true },
      });
    }
    if (
      args.join("\0") === ["open", sid, "--json"].join("\0") ||
      args.join("\0") ===
        ["open", sid, "--recover-restored-terminal", "--json"].join("\0")
    ) {
      const explicitRecovery = args.includes("--recover-restored-terminal");
      if (
        explicitRecovery &&
        this.pendingRestoredGeneration &&
        this.failRecoveryOpenOnce &&
        !this.recoveryOpenFailureInjected
      ) {
        this.recoveryOpenFailureInjected = true;
        return {
          exitCode: 1,
          stdout: "",
          stderr: "simulated failure before restored-generation reconcile",
        };
      }
      const fresh = this.dispatchLifecycle === "created";
      const restored = this.pendingRestoredGeneration;
      if (fresh) {
        this.dispatchLifecycle = "opened";
        this.lastSeq += 1;
      } else if (this.pendingRestoredGeneration) {
        this.lastSeq += 1;
        this.pendingRestoredGeneration = false;
      }
      return ok({
        sid,
        target: this.target,
        disposition: fresh ? "created" : "recovered",
        receipt: fresh || restored ? "recorded" : "already_recorded",
        recovery: restored ? "restored_terminal" : null,
        muxStatus: { state: "running", target: this.target, focused: true },
        projectionWarnings: [],
      });
    }
    if (
      args.join("\0") === ["close", sid, "--json"].join("\0") ||
      args.join("\0") ===
        ["close", sid, "--recover-restored-terminal", "--json"].join("\0")
    ) {
      if (
        this.failAfterInitialOpenWithTerminalConflict &&
        !args.includes("--recover-restored-terminal") &&
        this.dispatchLifecycle === "opened"
      ) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "simulated foreign terminal conflict",
        };
      }
      this.dispatchLifecycle = "closed";
      this.lastSeq += 1;
      return ok({
        sid,
        target: this.target,
        muxOutcome: "closed",
        alreadyClosed: false,
        receipt: "recorded",
        projectionWarnings: [],
      });
    }
    throw new Error(`unexpected Dispatch command: ${args.join(" ")}`);
  }

  private herdrStatus(selectedSession: string | null, socket: string) {
    return {
      client: { session: selectedSession, protocol: 18 },
      server: {
        running: true,
        session: selectedSession,
        socket,
        protocol: 18,
        compatible: true,
      },
    };
  }

  private snapshot(options: {
    readonly focusedWorkspaceId: string | null;
    readonly workspaceIds: readonly string[];
    readonly includeShape: boolean;
  }) {
    return {
      id: "cli:api:snapshot",
      result: {
        type: "session_snapshot",
        snapshot: {
          focused_workspace_id: options.focusedWorkspaceId,
          ...(options.includeShape
            ? {
                focused_tab_id: "operator-tab",
                focused_pane_id: "operator-pane",
              }
            : {}),
          workspaces: options.workspaceIds.map((workspaceId) => ({
            workspace_id: workspaceId,
          })),
          ...(options.includeShape
            ? {
                tabs: [{ tab_id: "operator-tab" }],
                panes: [
                  {
                    pane_id: "operator-pane",
                    terminal_id: "operator-terminal",
                  },
                ],
              }
            : {}),
        },
      },
    };
  }
}

function dependencies(environment: RestartEnvironment) {
  return {
    runner: environment.run,
    startServer: environment.startServer,
    sleep: async () => {},
    platform: "win32" as const,
    architecture: "x64",
    which: () => herdr,
    executableExists: () => true,
    sha256: () => "a".repeat(64),
    now: () => new Date("2026-07-31T23:30:00.000Z"),
    readinessAttempts: 2,
    sessionNonce: () => sessionNonce,
    bunVersion: "1.3.14",
    sourceProof: () => ({
      root: "C:\\Dispatch Source",
      commit: "c".repeat(40),
      branch: "agent/windows-restart-qualification",
      clean: true,
    }),
  };
}

describe("native Windows isolated restart qualification", () => {
  test("requires a non-default, argv-safe disposable session name", () => {
    const required = [
      "--binary",
      binary,
      "--sid",
      sid,
      "--herdr-session-prefix",
    ];
    expect(() =>
      parseWindowsRestartQualificationOptions([...required, "default"]),
    ).toThrow("non-default");
    for (const unsafe of ["bad/session", "-leading", "line\nbreak", "x".repeat(32)]) {
      expect(() =>
        parseWindowsRestartQualificationOptions([...required, unsafe]),
      ).toThrow("1-31 character prefix");
    }
  });

  test("never starts, stops, or deletes a preexisting named session", async () => {
    const environment = new RestartEnvironment({ preexistingNamed: true });

    await expect(
      qualifyWindowsRestart(
        { binary, herdr, sid, herdrSessionPrefix: sessionPrefix, cycles: 1 },
        dependencies(environment),
      ),
    ).rejects.toThrow("already exists");

    expect(environment.starts).toHaveLength(0);
    expect(environment.namedExists).toBeTrue();
    expect(environment.namedRunning).toBeTrue();
    expect(
      environment.invocations.some(
        ({ args }) =>
          args.includes("stop") ||
          args.join("\0") ===
            ["session", "delete", session, "--json"].join("\0"),
      ),
    ).toBeFalse();
  });

  test("runs one explicit restart, records the restored terminal generation, then closes and deletes", async () => {
    const environment = new RestartEnvironment();
    const initialTarget = {
      ...environment.target,
      server: { ...environment.target.server },
    };

    const evidence = await qualifyWindowsRestart(
      { binary, herdr, sid, herdrSessionPrefix: sessionPrefix, cycles: 1 },
      dependencies(environment),
    );

    expect(evidence).toMatchObject({
      verdict: "pass",
      completeFiveCycleGate: false,
      initial: { target: initialTarget, lastSeq: 3 },
      cycles: [
        {
          cycle: 1,
          stopped: true,
          socketApiRejected: true,
          restarted: true,
          workspaceShapeStable: true,
          terminalGenerationAdvanced: true,
          ledgerSequenceAdvanced: true,
          snapshotShapeRestored: true,
          terminalResponsive: true,
          defaultInvariantStable: true,
        },
      ],
      cleanup: {
        terminalCloseConfirmed: true,
        namedSessionStopped: true,
        namedSessionDeleted: true,
        retainedForRecovery: false,
        defaultInvariantStable: true,
        errors: [],
      },
    });
    expect(environment.starts).toEqual([
      { herdr, session },
      { herdr, session },
    ]);
    expect(environment.namedExists).toBeFalse();
    expect(environment.namedRunning).toBeFalse();
    expect(
      environment.invocations.filter(
        ({ executable, args }) =>
          executable === herdr &&
          args.join("\0") ===
            ["--session", session, "server", "stop"].join("\0"),
      ),
    ).toHaveLength(2);
    expect(
      environment.invocations.some(
        ({ executable, args }) =>
          executable === herdr &&
          args[0] === "--session" &&
          args[1] === session &&
          args[2] === "pane" &&
          args[3] === "run" &&
          args[5] === "cmd.exe /d /c echo DISPATCH_RESTART_1_AFTER",
      ),
    ).toBeTrue();
    expect(
      environment.invocations.filter(
        ({ executable, args }) =>
          executable === binary && args[0] === "close",
      ),
    ).toHaveLength(1);
  });

  test("fails closed and writes evidence when the default workspace invariant drifts", async () => {
    const environment = new RestartEnvironment({
      driftDefaultAfterBaseline: true,
    });
    let written: unknown;

    await expect(
      qualifyWindowsRestart(
        {
          binary,
          herdr,
          sid,
          herdrSessionPrefix: sessionPrefix,
          cycles: 1,
          output: "C:\\evidence\\restart.json",
        },
        {
          ...dependencies(environment),
          writeEvidence: (_path, evidence) => {
            written = evidence;
          },
        },
      ),
    ).rejects.toThrow("default Herdr server or operator focus changed");

    expect(written).toMatchObject({
      verdict: "fail",
      completeFiveCycleGate: false,
      cleanup: {
        terminalCloseConfirmed: false,
        namedSessionStopped: true,
        namedSessionDeleted: false,
        retainedForRecovery: true,
        defaultInvariantStable: false,
      },
    });
    expect(environment.starts).toHaveLength(1);
    expect(environment.namedExists).toBeTrue();
    expect(environment.namedRunning).toBeFalse();
    expect(
      environment.invocations.some(
        ({ args }) =>
          args.join("\0") ===
          ["session", "delete", session, "--json"].join("\0"),
      ),
    ).toBeFalse();
  });

  test("cleanup before a restart witness uses plain close and retains on terminal conflict", async () => {
    const environment = new RestartEnvironment({
      failAfterInitialOpenWithTerminalConflict: true,
    });
    let written: unknown;

    await expect(
      qualifyWindowsRestart(
        {
          binary,
          herdr,
          sid,
          herdrSessionPrefix: sessionPrefix,
          cycles: 1,
          output: "C:\\evidence\\pre-restart-failure.json",
        },
        {
          ...dependencies(environment),
          writeEvidence: (_path, evidence) => {
            written = evidence;
          },
        },
      ),
    ).rejects.toThrow("simulated status failure after initial open");

    expect(written).toMatchObject({
      verdict: "fail",
      cleanup: {
        terminalCloseConfirmed: false,
        namedSessionStopped: true,
        namedSessionDeleted: false,
        retainedForRecovery: true,
      },
    });
    expect(environment.namedExists).toBeTrue();
    expect(environment.namedRunning).toBeFalse();
    const close = environment.invocations.find(
      ({ executable, args }) => executable === binary && args[0] === "close",
    );
    expect(close?.args).toEqual(["close", sid, "--json"]);
  });

  test("cleanup may recover only after witnessing stop, socket rejection, and restart", async () => {
    const environment = new RestartEnvironment({
      failRecoveryOpenOnce: true,
    });
    let written: unknown;

    await expect(
      qualifyWindowsRestart(
        {
          binary,
          herdr,
          sid,
          herdrSessionPrefix: sessionPrefix,
          cycles: 1,
          output: "C:\\evidence\\post-restart-failure.json",
        },
        {
          ...dependencies(environment),
          writeEvidence: (_path, evidence) => {
            written = evidence;
          },
        },
      ),
    ).rejects.toThrow("simulated failure before restored-generation reconcile");

    expect(written).toMatchObject({
      verdict: "fail",
      cleanup: {
        terminalCloseConfirmed: true,
        namedSessionStopped: true,
        namedSessionDeleted: true,
        retainedForRecovery: false,
        errors: [],
      },
    });
    expect(environment.namedExists).toBeFalse();
    const close = environment.invocations.find(
      ({ executable, args }) => executable === binary && args[0] === "close",
    );
    expect(close?.args).toEqual([
      "close",
      sid,
      "--recover-restored-terminal",
      "--json",
    ]);
  });
});
