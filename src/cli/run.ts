import { CANONICAL_EVENT_KINDS } from "../core/ledger";
import { WorktreeError } from "../core/worktree";
import { DispatchError, errorMessage } from "../core/errors";
import type { SessionStatus } from "../core/index";
import type { Environment } from "../core/paths";
import { diagnose } from "../application/doctor";
import { installClaudeHooks } from "../application/hook-settings";
import {
  createSession,
  listSessions,
  mergeSession,
  reindexSessions,
  removeSession,
  sessionLog,
} from "../application/sessions";
import {
  booleanOption,
  integerOption,
  parseArguments,
  requirePositionals,
  stringOption,
  UsageError,
} from "./args";

export const DISPATCH_VERSION = "0.1.0";

const HELP = `Dispatch — durable agentic work sessions

Usage:
  dsp new [name] [--repo <path>] [--base <ref>] [--branch <ref>] [--path <path>] [--json]
  dsp ls [--limit <n>] [--status <status>] [--repo <path>] [--json]
  dsp log <sid> [--kind <kind>] [--limit <n>] [--json]
  dsp merge <sid> [--json]
  dsp remove <sid> [--force] [--json]
  dsp reindex [--json]
  dsp hooks install claude [--project <path>] [--command <path>] [--json]
  dsp doctor [--json]
  dsp --version

Hook installation defaults to Claude user scope (~/.claude/settings.json).
--project installs only in that project's .claude/settings.local.json and is
not inherited by future Dispatch worktrees.

The provider-facing fast path is: dsp hook claude`;

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function reportProjectionWarnings(warnings: readonly string[]): void {
  for (const warning of warnings) {
    console.error(`warning: ${warning}; run dsp reindex`);
  }
}

function sessionStatus(value: string | undefined): SessionStatus | undefined {
  if (value === undefined) return undefined;
  const statuses: readonly SessionStatus[] = [
    "active",
    "closed",
    "merged",
    "discarded",
    "removed",
  ];
  if (!statuses.includes(value as SessionStatus)) {
    throw new UsageError(`--status must be one of: ${statuses.join(", ")}`);
  }
  return value as SessionStatus;
}

async function runNew(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args, {
    repo: { type: "string" },
    base: { type: "string" },
    branch: { type: "string" },
    path: { type: "string" },
    json: { type: "boolean" },
  });
  requirePositionals(
    parsed,
    0,
    1,
    "dsp new [name] [--repo <path>] [--base <ref>] [--branch <ref>] [--path <path>]",
  );
  const name = parsed.positionals[0];
  const repositoryPath = stringOption(parsed, "repo");
  const baseRef = stringOption(parsed, "base");
  const branch = stringOption(parsed, "branch");
  const worktreePath = stringOption(parsed, "path");
  const result = await createSession({
    ...(name !== undefined ? { name } : {}),
    ...(repositoryPath !== undefined ? { repositoryPath } : {}),
    ...(baseRef !== undefined ? { baseRef } : {}),
    ...(branch !== undefined ? { branch } : {}),
    ...(worktreePath !== undefined ? { worktreePath } : {}),
  });
  reportProjectionWarnings(result.projectionWarnings);
  if (booleanOption(parsed, "json")) {
    printJson(result.meta);
  } else {
    console.log(`${result.meta.sid}\t${result.meta.worktreePath}`);
  }
}

async function runList(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args, {
    limit: { type: "string" },
    status: { type: "string" },
    repo: { type: "string" },
    json: { type: "boolean" },
  });
  requirePositionals(
    parsed,
    0,
    0,
    "dsp ls [--limit <n>] [--status <status>] [--repo <path>] [--json]",
  );
  const limit = integerOption(parsed, "limit", 100);
  const status = sessionStatus(stringOption(parsed, "status"));
  const repositoryPath = stringOption(parsed, "repo");
  const sessions = await listSessions({
    ...(limit !== undefined ? { limit } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(repositoryPath !== undefined ? { repositoryPath } : {}),
  });
  if (booleanOption(parsed, "json")) {
    printJson(sessions);
    return;
  }
  if (sessions.length === 0) {
    console.log("No sessions.");
    return;
  }
  console.log("SID\tSTATUS\tBRANCH\tWORKTREE");
  for (const session of sessions) {
    console.log(
      `${session.sid}\t${session.status}\t${session.branch}\t${session.worktreePath}`,
    );
  }
}

async function runLog(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args, {
    kind: { type: "string" },
    limit: { type: "string" },
    json: { type: "boolean" },
  });
  requirePositionals(
    parsed,
    1,
    1,
    "dsp log <sid> [--kind <kind>] [--limit <n>] [--json]",
  );
  const kind = stringOption(parsed, "kind");
  if (kind && !CANONICAL_EVENT_KINDS.includes(kind as never)) {
    throw new UsageError(
      `--kind must be canonical: ${CANONICAL_EVENT_KINDS.join(", ")}`,
    );
  }
  const limit = integerOption(parsed, "limit");
  const events = await sessionLog(parsed.positionals[0]!, {
    ...(kind !== undefined ? { kind } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
  if (booleanOption(parsed, "json")) {
    printJson(events);
    return;
  }
  for (const event of events) {
    console.log(
      `${event.seq}\t${event.ts}\t${event.kind}\t${JSON.stringify(event.data)}`,
    );
  }
}

async function runMerge(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args, { json: { type: "boolean" } });
  requirePositionals(parsed, 1, 1, "dsp merge <sid> [--json]");
  const result = await mergeSession(parsed.positionals[0]!);
  reportProjectionWarnings(result.projectionWarnings);
  if (booleanOption(parsed, "json")) printJson(result.value);
  else console.log(`${result.meta.sid}\tmerged\t${result.value.headCommit}`);
}

async function runRemove(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args, {
    force: { type: "boolean" },
    json: { type: "boolean" },
  });
  requirePositionals(parsed, 1, 1, "dsp remove <sid> [--force] [--json]");
  const result = await removeSession(
    parsed.positionals[0]!,
    booleanOption(parsed, "force"),
  );
  reportProjectionWarnings(result.projectionWarnings);
  if (booleanOption(parsed, "json")) printJson(result.value);
  else console.log(`${result.meta.sid}\tremoved\t${result.value.worktreePath}`);
}

async function runReindex(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args, { json: { type: "boolean" } });
  requirePositionals(parsed, 0, 0, "dsp reindex [--json]");
  const result = await reindexSessions();
  if (booleanOption(parsed, "json")) printJson(result);
  else console.log(`Reindexed ${result.events} events in ${result.sessions} sessions.`);
}

async function runHookInstall(
  args: readonly string[],
  env: Environment,
  writeLine: (value: string) => void,
): Promise<void> {
  const parsed = parseArguments(args, {
    project: { type: "string" },
    command: { type: "string" },
    json: { type: "boolean" },
  });
  requirePositionals(
    parsed,
    2,
    2,
    "dsp hooks install claude [--project <path>] [--command <path>] [--json]",
  );
  if (parsed.positionals[0] !== "install" || parsed.positionals[1] !== "claude") {
    throw new UsageError(
      "Only `dsp hooks install claude` is available in Stage 0.",
    );
  }
  const explicitProject = stringOption(parsed, "project");
  const command = stringOption(parsed, "command");
  const result = installClaudeHooks({
    ...(explicitProject !== undefined
      ? { projectPath: explicitProject }
      : {}),
    ...(command !== undefined ? { command } : {}),
    env,
  });
  if (booleanOption(parsed, "json")) {
    writeLine(JSON.stringify(result, null, 2));
    return;
  }

  writeLine(
    `${result.changed ? "updated" : "unchanged"}\t${result.scope}\t${result.path}`,
  );
  if (result.scope === "user") {
    writeLine(
      "User scope: future Dispatch worktrees inherit this hook; events outside Dispatch worktrees are ignored.",
    );
  } else {
    writeLine(
      "Project-local only: this hook is not inherited by future Dispatch worktrees.",
    );
  }
}

async function runDoctor(args: readonly string[]): Promise<number> {
  const parsed = parseArguments(args, { json: { type: "boolean" } });
  requirePositionals(parsed, 0, 0, "dsp doctor [--json]");
  const report = await diagnose();
  if (booleanOption(parsed, "json")) printJson(report);
  else {
    for (const check of report.checks) {
      console.log(`${check.status.toUpperCase()}\t${check.name}\t${check.detail}`);
    }
  }
  return report.readyForStage0 ? 0 : 1;
}

export async function runCli(
  args: readonly string[] = process.argv.slice(2),
  runtime: {
    readonly env?: Environment;
    readonly stdout?: (value: string) => void;
  } = {},
): Promise<number> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "help") {
    console.log(HELP);
    return 0;
  }
  if (args[0] === "--version" || args[0] === "version") {
    console.log(DISPATCH_VERSION);
    return 0;
  }

  try {
    switch (args[0]) {
      case "new":
        await runNew(args.slice(1));
        return 0;
      case "ls":
        await runList(args.slice(1));
        return 0;
      case "log":
        await runLog(args.slice(1));
        return 0;
      case "merge":
        await runMerge(args.slice(1));
        return 0;
      case "remove":
        await runRemove(args.slice(1));
        return 0;
      case "reindex":
        await runReindex(args.slice(1));
        return 0;
      case "hooks":
        await runHookInstall(
          args.slice(1),
          runtime.env ?? process.env,
          runtime.stdout ?? console.log,
        );
        return 0;
      case "doctor":
        return runDoctor(args.slice(1));
      default:
        throw new UsageError(`Unknown command: ${args[0]}\n\n${HELP}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      return error.exitCode;
    }
    if (error instanceof WorktreeError) {
      console.error(`${error.code}: ${error.message}`);
      if (error.stderr) console.error(error.stderr);
      return 4;
    }
    if (error instanceof DispatchError) {
      console.error(`${error.code}: ${error.message}`);
      return 1;
    }
    console.error(errorMessage(error));
    return 1;
  }
}
