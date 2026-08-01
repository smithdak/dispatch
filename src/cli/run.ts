import { CANONICAL_EVENT_KINDS } from "../core/ledger";
import { WorktreeError } from "../core/worktree";
import { DispatchError, errorMessage } from "../core/errors";
import type { SessionStatus } from "../core/index";
import type { Environment } from "../core/paths";
import { diagnose } from "../application/doctor";
import { installClaudeHooks } from "../application/hook-settings";
import {
  acknowledgeUnknownPrompt,
  closeTerminalSession,
  openTerminalSession,
  PRIVATE_PROMPT_MAX_UTF8_BYTES,
  promptTerminalSession,
  terminalSessionStatus,
} from "../application/orchestration";
import {
  createSession,
  listSessions,
  mergeSession,
  reindexSessions,
  removeSession,
  sessionLog,
} from "../application/sessions";
import {
  briefRepositoryWork,
  createWorkItem,
  getWorkItemBrief,
  listWorkItems,
  proposeWorkInsight,
  repairWorkLedger,
  setWorkStatus,
  startWorkSession,
  WORK_INSIGHT_KINDS,
  WORK_STATUSES,
} from "../application/work-items";
import {
  WorkLedgerCorruptionError,
  type WorkInsightKind,
  type WorkStatus,
} from "../core/work";
import {
  MuxError,
  type MuxPort,
  type MuxPromptPort,
} from "../ports/mux";
import {
  booleanOption,
  integerOption,
  parseArguments,
  requirePositionals,
  stringOption,
  UsageError,
} from "./args";

export const DISPATCH_VERSION = "0.2.0-alpha.3";

const HELP = `Dispatch — durable agentic work sessions

Usage:
  dsp work create <title> --key <stable-key> [--repo <path>] [--objective <text>] [--external <ref>] [--priority <1..5>] [--json]
  dsp work ls [--repo <path>] [--status <status>] [--limit <n>] [--json]
  dsp work show <wid> [--json]
  dsp work status <wid> <status> [--json]
  dsp work note <wid> --kind <kind> --stdin [--session <sid>] [--json]
  dsp work brief [query] [--repo <path>] [--limit <n>] [--json]
  dsp work repair [--json]
  dsp new [name] [--work <wid>] [--repo <path>] [--base <local-branch>] [--branch <new-branch>] [--path <path>] [--json]
  dsp ls [--limit <n>] [--status <status>] [--repo <path>] [--verify] [--json]
  dsp log <sid> [--kind <kind>] [--limit <n>] [--json]
  dsp merge <sid> [--json]
  dsp remove <sid> [--force] [--json]
  dsp open <sid> [--recover-restored-terminal] [--json]
  dsp status <sid> [--json]
  dsp close <sid> [--recover-restored-terminal] [--json]
  dsp prompt <sid> --stdin [--acknowledge-unknown <prompt-id>] [--json]
  dsp prompt <sid> --acknowledge-unknown <prompt-id> [--json]
  dsp reindex [--json]
  dsp hooks install claude [--project <path>] [--command <path>] [--json]
  dsp doctor [--stage1] [--json]
  dsp --version

Hook installation defaults to Claude user scope (~/.claude/settings.json).
--project installs only in that project's .claude/settings.local.json and is
not inherited by future Dispatch worktrees.

Private prompts are accepted only from piped stdin. Prompt bodies are never
accepted as positional arguments or option values.

The provider-facing fast path is: dsp hook claude`;

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function writeJson(value: unknown, writeLine: (value: string) => void): void {
  writeLine(JSON.stringify(value, null, 2));
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

async function runNew(
  args: readonly string[],
  env: Environment,
  writeLine: (value: string) => void,
  writeError: (value: string) => void,
): Promise<void> {
  const parsed = parseArguments(args, {
    work: { type: "string" },
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
    "dsp new [name] [--work <wid>] [--repo <path>] [--base <local-branch>] [--branch <new-branch>] [--path <path>]",
  );
  const name = parsed.positionals[0];
  const workId = stringOption(parsed, "work");
  const repositoryPath = stringOption(parsed, "repo");
  const baseRef = stringOption(parsed, "base");
  const branch = stringOption(parsed, "branch");
  const worktreePath = stringOption(parsed, "path");
  const sessionOptions = {
    ...(name !== undefined ? { name } : {}),
    ...(repositoryPath !== undefined ? { repositoryPath } : {}),
    ...(baseRef !== undefined ? { baseRef } : {}),
    ...(branch !== undefined ? { branch } : {}),
    ...(worktreePath !== undefined ? { worktreePath } : {}),
    env,
  };
  const result = workId
    ? await startWorkSession(workId, sessionOptions)
    : await createSession(sessionOptions);
  if (!workId) {
    writeError(
      "warning: session is not linked to work intelligence; duplicate prevention and roadmap continuity do not apply",
    );
  }
  reportProjectionWarnings(result.projectionWarnings);
  if (booleanOption(parsed, "json")) {
    writeJson(
      workId ? { ...result.meta, workId } : result.meta,
      writeLine,
    );
  } else {
    writeLine(`${result.meta.sid}\t${result.meta.worktreePath}`);
  }
}

async function runList(
  args: readonly string[],
  env: Environment,
  writeLine: (value: string) => void,
): Promise<void> {
  const parsed = parseArguments(args, {
    limit: { type: "string" },
    status: { type: "string" },
    repo: { type: "string" },
    verify: { type: "boolean" },
    json: { type: "boolean" },
  });
  requirePositionals(
    parsed,
    0,
    0,
    "dsp ls [--limit <n>] [--status <status>] [--repo <path>] [--verify] [--json]",
  );
  const limit = integerOption(parsed, "limit", 100);
  const status = sessionStatus(stringOption(parsed, "status"));
  const repositoryPath = stringOption(parsed, "repo");
  const sessions = await listSessions({
    ...(limit !== undefined ? { limit } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(repositoryPath !== undefined ? { repositoryPath } : {}),
    verify: booleanOption(parsed, "verify"),
    env,
  });
  if (booleanOption(parsed, "json")) {
    writeJson(sessions, writeLine);
    return;
  }
  if (sessions.length === 0) {
    writeLine("No sessions.");
    return;
  }
  writeLine("SID\tSTATUS\tBRANCH\tWORKTREE");
  for (const session of sessions) {
    writeLine(
      `${session.sid}\t${session.status}\t${session.branch}\t${session.worktreePath}`,
    );
  }
}

async function runLog(
  args: readonly string[],
  env: Environment,
  writeLine: (value: string) => void,
): Promise<void> {
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
    env,
  });
  if (booleanOption(parsed, "json")) {
    writeJson(events, writeLine);
    return;
  }
  for (const event of events) {
    writeLine(
      `${event.seq}\t${event.ts}\t${event.kind}\t${JSON.stringify(event.data)}`,
    );
  }
}

function workStatus(value: string | undefined): WorkStatus | undefined {
  if (value === undefined) return undefined;
  if (!WORK_STATUSES.includes(value as WorkStatus)) {
    throw new UsageError(
      `work status must be one of: ${WORK_STATUSES.join(", ")}`,
    );
  }
  return value as WorkStatus;
}

function insightKind(value: string | undefined): WorkInsightKind {
  if (
    value === undefined ||
    !WORK_INSIGHT_KINDS.includes(value as WorkInsightKind)
  ) {
    throw new UsageError(
      `--kind must be one of: ${WORK_INSIGHT_KINDS.join(", ")}`,
    );
  }
  return value as WorkInsightKind;
}

async function runWork(
  args: readonly string[],
  runtime: {
    readonly env: Environment;
    readonly readStdin: () => Promise<string>;
    readonly stdinIsTTY: boolean;
    readonly writeLine: (value: string) => void;
  },
): Promise<void> {
  const subcommand = args[0];
  if (!subcommand) {
    throw new UsageError(
      "dsp work requires create, ls, show, status, note, brief, or repair.",
    );
  }

  switch (subcommand) {
    case "create": {
      const parsed = parseArguments(args.slice(1), {
        key: { type: "string" },
        repo: { type: "string" },
        objective: { type: "string" },
        external: { type: "string" },
        priority: { type: "string" },
        json: { type: "boolean" },
      });
      requirePositionals(
        parsed,
        1,
        1,
        "dsp work create <title> --key <stable-key> [--repo <path>] [--objective <text>] [--external <ref>] [--priority <1..5>] [--json]",
      );
      const key = stringOption(parsed, "key");
      if (!key) throw new UsageError("dsp work create requires --key.");
      const repositoryPath = stringOption(parsed, "repo");
      const objective = stringOption(parsed, "objective");
      const externalRef = stringOption(parsed, "external");
      const priority = integerOption(parsed, "priority");
      const result = await createWorkItem({
        key,
        title: parsed.positionals[0]!,
        ...(repositoryPath === undefined ? {} : { repositoryPath }),
        ...(objective === undefined ? {} : { objective }),
        ...(externalRef === undefined ? {} : { externalRef }),
        ...(priority === undefined ? {} : { priority }),
        env: runtime.env,
      });
      if (booleanOption(parsed, "json")) {
        writeJson(result, runtime.writeLine);
      } else {
        runtime.writeLine(
          `${result.item.wid}\t${result.created ? "created" : "existing"}\t${result.item.key}\t${result.item.title}`,
        );
      }
      return;
    }
    case "ls": {
      const parsed = parseArguments(args.slice(1), {
        repo: { type: "string" },
        status: { type: "string" },
        limit: { type: "string" },
        json: { type: "boolean" },
      });
      requirePositionals(
        parsed,
        0,
        0,
        "dsp work ls [--repo <path>] [--status <status>] [--limit <n>] [--json]",
      );
      const repositoryPath = stringOption(parsed, "repo");
      const status = workStatus(stringOption(parsed, "status"));
      const limit = integerOption(parsed, "limit", 100);
      const items = await listWorkItems({
        ...(repositoryPath === undefined ? {} : { repositoryPath }),
        ...(status === undefined ? {} : { status }),
        ...(limit === undefined ? {} : { limit }),
        env: runtime.env,
      });
      if (booleanOption(parsed, "json")) {
        writeJson(items, runtime.writeLine);
      } else if (items.length === 0) {
        runtime.writeLine("No work items.");
      } else {
        runtime.writeLine("WID\tSTATUS\tPRIORITY\tKEY\tTITLE");
        for (const item of items) {
          runtime.writeLine(
            `${item.wid}\t${item.status}\t${item.priority}\t${item.key}\t${item.title}`,
          );
        }
      }
      return;
    }
    case "show": {
      const parsed = parseArguments(args.slice(1), {
        json: { type: "boolean" },
      });
      requirePositionals(parsed, 1, 1, "dsp work show <wid> [--json]");
      const brief = await getWorkItemBrief(parsed.positionals[0]!, {
        env: runtime.env,
      });
      if (booleanOption(parsed, "json")) {
        writeJson(brief, runtime.writeLine);
      } else {
        runtime.writeLine(
          `${brief.item.wid}\t${brief.item.status}\t${brief.item.priority}\t${brief.item.key}\t${brief.item.title}`,
        );
        runtime.writeLine(
          `evidence\t${brief.evidence.attempts}\t${brief.evidence.active}\t${brief.evidence.merged}\t${brief.evidence.discarded}\t${brief.evidence.unresolved}`,
        );
        for (const attempt of brief.attempts) {
          runtime.writeLine(
            `attempt\t${attempt.sid}\t${attempt.state}\t${attempt.disposition ?? "-"}`,
          );
        }
        for (const insight of brief.item.insights) {
          runtime.writeLine(
            `insight\t${insight.iid}\t${insight.kind}\t${insight.sessionId ?? "-"}\t${insight.body}`,
          );
        }
      }
      return;
    }
    case "status": {
      const parsed = parseArguments(args.slice(1), {
        json: { type: "boolean" },
      });
      requirePositionals(
        parsed,
        2,
        2,
        "dsp work status <wid> <status> [--json]",
      );
      const status = workStatus(parsed.positionals[1]);
      const item = await setWorkStatus(
        parsed.positionals[0]!,
        status!,
        { env: runtime.env },
      );
      if (booleanOption(parsed, "json")) {
        writeJson(item, runtime.writeLine);
      } else {
        runtime.writeLine(`${item.wid}\t${item.status}`);
      }
      return;
    }
    case "note": {
      const parsed = parseArguments(args.slice(1), {
        kind: { type: "string" },
        stdin: { type: "boolean" },
        session: { type: "string" },
        json: { type: "boolean" },
      });
      requirePositionals(
        parsed,
        1,
        1,
        "dsp work note <wid> --kind <kind> --stdin [--session <sid>] [--json]",
      );
      if (!booleanOption(parsed, "stdin")) {
        throw new UsageError("dsp work note requires --stdin.");
      }
      if (runtime.stdinIsTTY) {
        throw new UsageError("Work insight stdin must be piped.");
      }
      const sessionId = stringOption(parsed, "session");
      const item = await proposeWorkInsight(
        parsed.positionals[0]!,
        insightKind(stringOption(parsed, "kind")),
        await runtime.readStdin(),
        {
          ...(sessionId === undefined ? {} : { sessionId }),
          env: runtime.env,
        },
      );
      if (booleanOption(parsed, "json")) {
        writeJson(item, runtime.writeLine);
      } else {
        runtime.writeLine(
          `${item.wid}\tinsight_proposed\t${item.insights.at(-1)?.iid ?? "-"}`,
        );
      }
      return;
    }
    case "brief": {
      const parsed = parseArguments(args.slice(1), {
        repo: { type: "string" },
        limit: { type: "string" },
        json: { type: "boolean" },
      });
      requirePositionals(
        parsed,
        0,
        1,
        "dsp work brief [query] [--repo <path>] [--limit <n>] [--json]",
      );
      const repositoryPath = stringOption(parsed, "repo");
      const limit = integerOption(parsed, "limit", 10);
      const brief = await briefRepositoryWork(parsed.positionals[0], {
        ...(repositoryPath === undefined ? {} : { repositoryPath }),
        ...(limit === undefined ? {} : { limit }),
        env: runtime.env,
      });
      if (booleanOption(parsed, "json")) {
        writeJson(brief, runtime.writeLine);
      } else {
        for (const [queue, items] of Object.entries(brief.roadmap)) {
          for (const item of items) {
            runtime.writeLine(
              `${queue}\t${item.item.wid}\t${item.item.priority}\t${item.item.key}\t${item.item.title}`,
            );
          }
        }
        for (const match of brief.matches) {
          runtime.writeLine(
            `match\t${match.item.wid}\t${match.score.toFixed(3)}\t${match.sharedTokens.join(",")}\t${match.evidence.attempts}\t${match.evidence.merged}\t${match.evidence.discarded}\t${match.evidence.unresolved}\t${match.item.title}`,
          );
        }
        if (
          Object.values(brief.roadmap).every((items) => items.length === 0) &&
          brief.matches.length === 0
        ) {
          runtime.writeLine("No work intelligence for this repository.");
        }
      }
      return;
    }
    case "repair": {
      const parsed = parseArguments(args.slice(1), {
        json: { type: "boolean" },
      });
      requirePositionals(parsed, 0, 0, "dsp work repair [--json]");
      const result = await repairWorkLedger({ env: runtime.env });
      if (booleanOption(parsed, "json")) {
        writeJson(result, runtime.writeLine);
      } else {
        runtime.writeLine(
          `${result.repaired ? "repaired" : "healthy"}\t${result.bytesRemoved}\t${result.lastSequence}`,
        );
      }
      return;
    }
    default:
      throw new UsageError(`Unknown work command: ${subcommand}`);
  }
}

async function runMerge(
  args: readonly string[],
  env: Environment,
  writeLine: (value: string) => void,
): Promise<void> {
  const parsed = parseArguments(args, { json: { type: "boolean" } });
  requirePositionals(parsed, 1, 1, "dsp merge <sid> [--json]");
  const result = await mergeSession(parsed.positionals[0]!, { env });
  reportProjectionWarnings(result.projectionWarnings);
  if (booleanOption(parsed, "json")) writeJson(result.value, writeLine);
  else writeLine(`${result.meta.sid}\tmerged\t${result.value.headCommit}`);
}

async function runRemove(
  args: readonly string[],
  env: Environment,
  writeLine: (value: string) => void,
): Promise<void> {
  const parsed = parseArguments(args, {
    force: { type: "boolean" },
    json: { type: "boolean" },
  });
  requirePositionals(parsed, 1, 1, "dsp remove <sid> [--force] [--json]");
  const result = await removeSession(
    parsed.positionals[0]!,
    booleanOption(parsed, "force"),
    { env },
  );
  reportProjectionWarnings(result.projectionWarnings);
  if (booleanOption(parsed, "json")) writeJson(result.value, writeLine);
  else writeLine(`${result.meta.sid}\tremoved\t${result.value.worktreePath}`);
}

async function runOpen(
  args: readonly string[],
  loadMux: () => Promise<MuxPort>,
  env: Environment,
): Promise<void> {
  const parsed = parseArguments(args, {
    "recover-restored-terminal": { type: "boolean" },
    json: { type: "boolean" },
  });
  requirePositionals(
    parsed,
    1,
    1,
    "dsp open <sid> [--recover-restored-terminal] [--json]",
  );
  const result = await openTerminalSession(
    parsed.positionals[0]!,
    await loadMux(),
    {
      env,
      allowRestoredGeneration: booleanOption(
        parsed,
        "recover-restored-terminal",
      ),
    },
  );
  reportProjectionWarnings(result.projectionWarnings);
  if (booleanOption(parsed, "json")) {
    printJson(result);
    return;
  }
  console.log(
    `${result.sid}\topened\t${result.disposition}\t${result.target.workspaceId}`,
  );
}

async function runStatus(
  args: readonly string[],
  loadMux: () => Promise<MuxPort>,
  env: Environment,
): Promise<void> {
  const parsed = parseArguments(args, { json: { type: "boolean" } });
  requirePositionals(parsed, 1, 1, "dsp status <sid> [--json]");
  const result = await terminalSessionStatus(
    parsed.positionals[0]!,
    await loadMux(),
    { env },
  );
  if (booleanOption(parsed, "json")) {
    printJson(result);
    return;
  }
  console.log(
    `${result.sid}\t${result.dispatchLifecycle}\t${result.muxStatus.state}\t${result.target?.workspaceId ?? "-"}`,
  );
}

async function runClose(
  args: readonly string[],
  loadMux: () => Promise<MuxPort>,
  env: Environment,
): Promise<void> {
  const parsed = parseArguments(args, {
    "recover-restored-terminal": { type: "boolean" },
    json: { type: "boolean" },
  });
  requirePositionals(
    parsed,
    1,
    1,
    "dsp close <sid> [--recover-restored-terminal] [--json]",
  );
  const result = await closeTerminalSession(
    parsed.positionals[0]!,
    await loadMux(),
    {
      env,
      allowRestoredGeneration: booleanOption(
        parsed,
        "recover-restored-terminal",
      ),
    },
  );
  reportProjectionWarnings(result.projectionWarnings);
  if (booleanOption(parsed, "json")) {
    printJson(result);
    return;
  }
  console.log(
    `${result.sid}\tclosed\t${result.muxOutcome}\t${result.target?.workspaceId ?? "-"}`,
  );
}

const PRIVATE_PROMPT_STDIN_LIMIT = PRIVATE_PROMPT_MAX_UTF8_BYTES + 2;

async function readStandardInput(): Promise<string> {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for await (const chunk of process.stdin) {
    const bytes = typeof chunk === "string"
      ? new TextEncoder().encode(chunk)
      : new Uint8Array(chunk as Uint8Array);
    totalBytes += bytes.byteLength;
    if (totalBytes > PRIVATE_PROMPT_STDIN_LIMIT) {
      throw new DispatchError(
        "session.prompt_invalid",
        `Private prompt stdin exceeds the ${PRIVATE_PROMPT_MAX_UTF8_BYTES}-byte limit.`,
        { maxBytes: PRIVATE_PROMPT_MAX_UTF8_BYTES },
      );
    }
    chunks.push(bytes);
  }
  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(joined);
  } catch (error) {
    throw new DispatchError(
      "session.prompt_invalid",
      "Private prompt stdin must be valid UTF-8.",
      {},
      { cause: error },
    );
  }
}

function oneLinePromptFromStdin(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

async function runPrompt(
  args: readonly string[],
  loadMux: () => Promise<MuxPort & MuxPromptPort>,
  env: Environment,
  readStdin: () => Promise<string>,
  stdinIsTTY: boolean,
  writeLine: (value: string) => void,
): Promise<void> {
  const parsed = parseArguments(args, {
    stdin: { type: "boolean" },
    "acknowledge-unknown": { type: "string" },
    json: { type: "boolean" },
  });
  requirePositionals(
    parsed,
    1,
    1,
    "dsp prompt <sid> --stdin [--acknowledge-unknown <prompt-id>] [--json]",
  );
  const sid = parsed.positionals[0]!;
  const fromStdin = booleanOption(parsed, "stdin");
  const acknowledgement = stringOption(parsed, "acknowledge-unknown");
  if (!fromStdin && acknowledgement === undefined) {
    throw new UsageError(
      "dsp prompt requires --stdin or --acknowledge-unknown <prompt-id>.",
    );
  }

  if (!fromStdin) {
    const result = await acknowledgeUnknownPrompt(sid, acknowledgement!, {
      env,
    });
    reportProjectionWarnings(result.projectionWarnings);
    if (booleanOption(parsed, "json")) {
      writeLine(JSON.stringify(result, null, 2));
    } else {
      writeLine(
        `${result.sid}\tprompt_unknown_acknowledged\t${result.promptId}`,
      );
    }
    return;
  }
  if (stdinIsTTY) {
    throw new UsageError(
      "Private prompt stdin must be piped; interactive terminal input is not accepted.",
    );
  }
  const text = oneLinePromptFromStdin(await readStdin());
  const result = await promptTerminalSession(sid, text, await loadMux(), {
    env,
    ...(acknowledgement === undefined
      ? {}
      : { acknowledgeUnknownPromptId: acknowledgement }),
  });
  reportProjectionWarnings(result.projectionWarnings);
  if (booleanOption(parsed, "json")) {
    writeLine(JSON.stringify(result, null, 2));
  } else {
    writeLine(
      `${result.sid}\tprompt_accepted\t${result.promptId}\t${result.target.workspaceId}`,
    );
  }
}

async function runReindex(
  args: readonly string[],
  env: Environment,
  writeLine: (value: string) => void,
): Promise<void> {
  const parsed = parseArguments(args, { json: { type: "boolean" } });
  requirePositionals(parsed, 0, 0, "dsp reindex [--json]");
  const result = await reindexSessions({ env });
  if (booleanOption(parsed, "json")) writeJson(result, writeLine);
  else writeLine(`Reindexed ${result.events} events in ${result.sessions} sessions.`);
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
  const parsed = parseArguments(args, {
    stage1: { type: "boolean" },
    json: { type: "boolean" },
  });
  requirePositionals(parsed, 0, 0, "dsp doctor [--stage1] [--json]");
  const report = await diagnose();
  if (booleanOption(parsed, "json")) printJson(report);
  else {
    for (const check of report.checks) {
      console.log(`${check.status.toUpperCase()}\t${check.name}\t${check.detail}`);
    }
  }
  return (
    booleanOption(parsed, "stage1")
      ? report.readyForStage1
      : report.readyForStage0
  )
    ? 0
    : 1;
}

export async function runCli(
  args: readonly string[] = process.argv.slice(2),
  runtime: {
    readonly env?: Environment;
    readonly stdout?: (value: string) => void;
    readonly stderr?: (value: string) => void;
    readonly mux?: MuxPort & MuxPromptPort;
    readonly readStdin?: () => Promise<string>;
    readonly stdinIsTTY?: boolean;
  } = {},
): Promise<number> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "help") {
    (runtime.stdout ?? console.log)(HELP);
    return 0;
  }
  if (args[0] === "--version" || args[0] === "version") {
    (runtime.stdout ?? console.log)(DISPATCH_VERSION);
    return 0;
  }

  try {
    const orchestrationMux = async (): Promise<MuxPort & MuxPromptPort> => {
      if (runtime.mux) return runtime.mux;
      const { loadMuxPort } = await import("../adapters/registry");
      return loadMuxPort(runtime.env ?? process.env);
    };
    switch (args[0]) {
      case "work":
        await runWork(args.slice(1), {
          env: runtime.env ?? process.env,
          readStdin: runtime.readStdin ?? readStandardInput,
          stdinIsTTY:
            runtime.stdinIsTTY ??
            (runtime.readStdin === undefined && Boolean(process.stdin.isTTY)),
          writeLine: runtime.stdout ?? console.log,
        });
        return 0;
      case "new":
        await runNew(
          args.slice(1),
          runtime.env ?? process.env,
          runtime.stdout ?? console.log,
          runtime.stderr ?? console.error,
        );
        return 0;
      case "ls":
        await runList(
          args.slice(1),
          runtime.env ?? process.env,
          runtime.stdout ?? console.log,
        );
        return 0;
      case "log":
        await runLog(
          args.slice(1),
          runtime.env ?? process.env,
          runtime.stdout ?? console.log,
        );
        return 0;
      case "merge":
        await runMerge(
          args.slice(1),
          runtime.env ?? process.env,
          runtime.stdout ?? console.log,
        );
        return 0;
      case "remove":
        await runRemove(
          args.slice(1),
          runtime.env ?? process.env,
          runtime.stdout ?? console.log,
        );
        return 0;
      case "open":
        await runOpen(
          args.slice(1),
          orchestrationMux,
          runtime.env ?? process.env,
        );
        return 0;
      case "status":
        await runStatus(
          args.slice(1),
          orchestrationMux,
          runtime.env ?? process.env,
        );
        return 0;
      case "close":
        await runClose(
          args.slice(1),
          orchestrationMux,
          runtime.env ?? process.env,
        );
        return 0;
      case "prompt":
        await runPrompt(
          args.slice(1),
          orchestrationMux,
          runtime.env ?? process.env,
          runtime.readStdin ?? readStandardInput,
          runtime.stdinIsTTY ??
            (runtime.readStdin === undefined && Boolean(process.stdin.isTTY)),
          runtime.stdout ?? console.log,
        );
        return 0;
      case "reindex":
        await runReindex(
          args.slice(1),
          runtime.env ?? process.env,
          runtime.stdout ?? console.log,
        );
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
    const writeError = runtime.stderr ?? console.error;
    const jsonError = args.includes("--json");
    if (error instanceof UsageError) {
      if (jsonError) {
        writeJson(
          { error: { code: "usage.invalid", message: error.message } },
          writeError,
        );
      } else {
        writeError(error.message);
      }
      return error.exitCode;
    }
    if (error instanceof WorktreeError) {
      if (jsonError) {
        writeJson(
          {
            error: {
              code: `worktree.${error.code}`,
              message: error.message,
              details: {
                operation: error.operation,
                path: error.path,
                argv: error.argv,
                exitCode: error.exitCode ?? null,
                stderr: error.stderr ?? null,
              },
            },
          },
          writeError,
        );
      } else {
        writeError(`${error.code}: ${error.message}`);
        if (error.stderr) writeError(error.stderr);
      }
      return 4;
    }
    if (error instanceof MuxError) {
      if (jsonError) {
        writeJson(
          {
            error: {
              code: `mux.${error.code}`,
              message: error.message,
              details: error.details,
            },
          },
          writeError,
        );
      } else {
        writeError(`mux.${error.code}: ${error.message}`);
      }
      return 5;
    }
    if (error instanceof DispatchError) {
      if (jsonError) {
        writeJson(
          {
            error: {
              code: error.code,
              message: error.message,
              details: error.details,
            },
          },
          writeError,
        );
      } else {
        writeError(`${error.code}: ${error.message}`);
      }
      return 1;
    }
    if (error instanceof WorkLedgerCorruptionError) {
      if (jsonError) {
        writeJson(
          {
            error: {
              code: "work.ledger_corrupt",
              message: error.message,
              details: {
                eventsPath: error.eventsPath,
                issues: error.issues,
              },
            },
          },
          writeError,
        );
      } else {
        writeError(`work.ledger_corrupt: ${error.message}`);
        for (const issue of error.issues) {
          writeError(
            `${issue.code}\tline=${issue.line}\t${issue.message}`,
          );
        }
      }
      return 1;
    }
    if (jsonError) {
      writeJson(
        {
          error: {
            code: "internal.error",
            message: errorMessage(error),
          },
        },
        writeError,
      );
    } else {
      writeError(errorMessage(error));
    }
    return 1;
  }
}
