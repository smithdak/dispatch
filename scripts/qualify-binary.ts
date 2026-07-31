import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface CommandOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly stdin?: string;
}

function run(
  cmd: readonly string[],
  options: CommandOptions = {},
): string {
  const result =
    options.stdin === undefined
      ? Bun.spawnSync([...cmd], {
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options.env === undefined ? {} : { env: options.env }),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        })
      : Bun.spawnSync([...cmd], {
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options.env === undefined ? {} : { env: options.env }),
          stdin: new Blob([`${options.stdin}\n`]),
          stdout: "pipe",
          stderr: "pipe",
        });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0) {
    throw new Error(
      `${JSON.stringify(cmd)} failed (${result.exitCode}): ${stderr.trim()}`,
    );
  }
  return stdout.trim();
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const root = mkdtempSync(join(tmpdir(), "dispatch-binary-qualification-"));
const repository = join(root, "repository");
const binary = resolve(
  import.meta.dir,
  "..",
  "dist",
  process.platform === "win32" ? "dsp.exe" : "dsp",
);

try {
  assert(existsSync(binary), `Compiled binary does not exist: ${binary}`);
  run(["git", "init", "--initial-branch=main", "--", repository]);
  run(["git", "-C", repository, "config", "user.name", "Dispatch Qualification"]);
  run([
    "git",
    "-C",
    repository,
    "config",
    "user.email",
    "dispatch-qualification@example.invalid",
  ]);
  run(["git", "-C", repository, "commit", "--allow-empty", "-m", "initial"]);

  const env = {
    ...process.env,
    DISPATCH_HOME: join(root, "state"),
    DISPATCH_WORKTREE_ROOT: join(root, "worktrees"),
    DISPATCH_BRANCH_PREFIX: "dispatch-qualification/",
  };
  const doctor = JSON.parse(
    run([binary, "doctor", "--json"], { env }),
  ) as { readyForStage0?: boolean };
  assert(doctor.readyForStage0 === true, "Compiled doctor did not qualify Stage 0");

  const hookInstall = JSON.parse(
    run([binary, "hooks", "install", "claude", "--json"], {
      env: { ...env, HOME: join(root, "home"), USERPROFILE: join(root, "home") },
    }),
  ) as { path?: string };
  assert(typeof hookInstall.path === "string", "Hook install returned no path");
  const hookSettings = JSON.parse(readFileSync(hookInstall.path, "utf8")) as {
    hooks?: Record<
      string,
      Array<{
        hooks?: Array<{ command?: string; args?: string[] }>;
      }>
    >;
  };
  const hook = hookSettings.hooks?.PreToolUse?.[0]?.hooks?.[0];
  assert(
    hook?.command === binary,
    `Compiled hook did not self-register its absolute executable: ${String(hook?.command)}`,
  );
  assert(
    hook.args?.join("\0") === ["hook", "claude"].join("\0"),
    "Compiled hook did not use the expected exec-form arguments",
  );

  const created = JSON.parse(
    run(
      [binary, "new", "Compiled lifecycle", "--repo", repository, "--json"],
      { env },
    ),
  ) as { sid?: string; worktreePath?: string };
  assert(typeof created.sid === "string", "dsp new returned no SID");
  assert(
    typeof created.worktreePath === "string",
    "dsp new returned no worktree path",
  );

  run([binary, "hook", "claude"], {
    env,
    stdin: JSON.stringify({
      session_id: "compiled-binary-qualification",
      transcript_path: join(root, "transcript.jsonl"),
      cwd: created.worktreePath,
      permission_mode: "default",
      hook_event_name: "SessionStart",
      source: "startup",
    }),
  });
  run([
    "git",
    "-C",
    created.worktreePath,
    "commit",
    "--allow-empty",
    "-m",
    "compiled lifecycle",
  ]);

  const events = JSON.parse(
    run([binary, "log", created.sid, "--json"], { env }),
  ) as Array<{ kind?: string }>;
  assert(
    events.some((event) => event.kind === "agent.started"),
    "Compiled hook event did not reach the ledger",
  );

  run([binary, "merge", created.sid, "--json"], { env });
  run([binary, "remove", created.sid, "--json"], { env });
  const sessions = JSON.parse(
    run([binary, "ls", "--repo", repository, "--json"], { env }),
  ) as Array<{ status?: string }>;
  assert(sessions[0]?.status === "removed", "Compiled lifecycle did not finish removed");
  assert(
    !existsSync(created.worktreePath),
    "Compiled lifecycle left its worktree behind",
  );

  console.log(
    JSON.stringify({
      platform: `${process.platform}/${process.arch}`,
      bun: Bun.version,
      binary,
      sid: created.sid,
      events: events.map((event) => event.kind),
      finalStatus: sessions[0]?.status,
    }),
  );
} finally {
  rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
