import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  createSession,
  listSessions,
  mergeSession,
  reindexSessions,
  removeSession,
  sessionLog,
} from "../../src/application/sessions";
import { sessionEventsPath } from "../../src/application/session-meta";
import { createSortableId } from "../../src/core/identity";
import { JsonlLedger } from "../../src/core/ledger";
import {
  ensureMachineId,
  resolveDispatchPaths,
} from "../../src/core/paths";
import { mergeWorktree, planWorktree } from "../../src/core/worktree";

const fixtureRoots: string[] = [];
const STAGE_ZERO_TIMEOUT_MS = 90_000;
const ISOLATED_ENVIRONMENT_KEYS = [
  "HOME",
  "USERPROFILE",
  "XDG_STATE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "DISPATCH_HOME",
  "DISPATCH_WORKTREE_ROOT",
  "DISPATCH_BRANCH_PREFIX",
] as const;

async function runClaudeHookProcess(
  payload: Record<string, unknown>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const entrypoint = resolve(import.meta.dir, "../../src/cli/main.ts");
  const child = Bun.spawn(
    [process.execPath, entrypoint, "hook", "claude"],
    {
      cwd: resolve(import.meta.dir, "../.."),
      env: process.env,
      stdin: new Blob([`${JSON.stringify(payload)}\n`]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const argv = ["git", "-C", cwd, ...args];
  const subprocess = Bun.spawn({
    cmd: argv,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = new Response(subprocess.stdout).text();
  const stderrPromise = new Response(subprocess.stderr).text();
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    stdoutPromise,
    stderrPromise,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${JSON.stringify(argv)} failed (${exitCode}): ${stderr.trim()}`,
    );
  }

  return stdout.trim();
}

function pointProcessEnvironmentAt(root: string): () => void {
  const previous = new Map(
    ISOLATED_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
  );
  const home = join(root, "home");
  const values: Record<(typeof ISOLATED_ENVIRONMENT_KEYS)[number], string> = {
    HOME: home,
    USERPROFILE: home,
    XDG_STATE_HOME: join(root, "xdg-state"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_CACHE_HOME: join(root, "xdg-cache"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    DISPATCH_HOME: join(root, "dispatch-state"),
    DISPATCH_WORKTREE_ROOT: join(root, "session-worktrees"),
    DISPATCH_BRANCH_PREFIX: "dispatch-e2e/",
  };

  for (const key of ISOLATED_ENVIRONMENT_KEYS) {
    process.env[key] = values[key];
  }

  return () => {
    for (const key of ISOLATED_ENVIRONMENT_KEYS) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

async function createRepository(root: string): Promise<string> {
  const repositoryPath = join(root, "repository");
  await mkdir(repositoryPath, { recursive: true });
  await git(root, [
    "init",
    "--initial-branch=main",
    "--",
    repositoryPath,
  ]);
  await git(repositoryPath, ["config", "user.name", "Dispatch Tests"]);
  await git(repositoryPath, [
    "config",
    "user.email",
    "dispatch-tests@example.invalid",
  ]);
  await git(repositoryPath, ["config", "core.autocrlf", "false"]);
  await writeFile(join(repositoryPath, "README.md"), "# Stage 0 fixture\n");
  await git(repositoryPath, ["add", "--", "README.md"]);
  await git(repositoryPath, ["commit", "-m", "initial"]);
  return repositoryPath;
}

afterEach(async () => {
  const roots = fixtureRoots.splice(0);
  await Promise.all(
    roots.map((root) =>
      rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      }),
    ),
  );
});

test.serial(
  "runs the Stage 0 session lifecycle through authoritative state and rebuilds the index",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "dispatch-stage-zero-"));
    fixtureRoots.push(root);
    const restoreEnvironment = pointProcessEnvironmentAt(root);

    try {
      const repositoryPath = await createRepository(root);
      const physicalRoot = await realpath(root);
      const physicalRepositoryPath = await realpath(repositoryPath);
      const initialCommit = await git(repositoryPath, ["rev-parse", "HEAD"]);
      const paths = resolveDispatchPaths(process.env);
      const configuredWorktreeRoot = join(physicalRoot, "session-worktrees");

      expect(paths.stateDir).toBe(resolve(root, "dispatch-state"));
      expect(paths.configDir).toBe(resolve(root, "xdg-config", "dispatch"));
      expect(paths.cacheDir).toBe(resolve(root, "xdg-cache", "dispatch"));

      const created = await createSession({
        name: "Stage 0 Lifecycle",
        repositoryPath,
        paths,
        env: process.env,
      });
      expect(created.projectionWarnings).toEqual([]);
      expect(created.value).toEqual(created.meta);
      expect(created.meta).toMatchObject({
        v: 1,
        repositoryPath: physicalRepositoryPath,
        branch: `dispatch-e2e/stage-0-lifecycle-${created.meta.sid}`,
        baseBranch: "main",
        baseCommit: initialCommit,
      });
      expect(
        created.meta.worktreePath.startsWith(configuredWorktreeRoot),
      ).toBeTrue();
      expect(new Date(created.meta.createdAt).toISOString()).toBe(
        created.meta.createdAt,
      );

      const metaPath = join(
        paths.sessionsDir,
        created.meta.sid,
        "meta.json",
      );
      const immutableMeta = await readFile(metaPath, "utf8");
      expect(JSON.parse(immutableMeta)).toEqual(created.meta);

      const creationLog = await sessionLog(created.meta.sid, { paths });
      expect(
        creationLog.map((event) => ({
          seq: event.seq,
          src: event.src,
          kind: event.kind,
        })),
      ).toEqual([
        { seq: 1, src: "dsp", kind: "session.created" },
        { seq: 2, src: "dsp", kind: "worktree.created" },
      ]);
      expect(creationLog[0]?.data).toMatchObject({
        repositoryPath: created.meta.repositoryPath,
        worktreePath: created.meta.worktreePath,
        branch: created.meta.branch,
        baseBranch: created.meta.baseBranch,
        baseCommit: created.meta.baseCommit,
        createdAt: created.meta.createdAt,
      });
      expect(creationLog[1]?.data).toEqual({
        path: created.meta.worktreePath,
        branch: created.meta.branch,
        baseCommit: created.meta.baseCommit,
      });

      const sourceDirectory = join(created.meta.worktreePath, "src");
      const sessionFile = join(sourceDirectory, "stage-zero.txt");
      await mkdir(sourceDirectory, { recursive: true });
      await writeFile(sessionFile, "stage zero lifecycle\n");
      await git(created.meta.worktreePath, [
        "add",
        "--",
        "src/stage-zero.txt",
      ]);
      await git(created.meta.worktreePath, [
        "commit",
        "-m",
        "complete Stage 0 change",
      ]);
      const sessionCommit = await git(created.meta.worktreePath, [
        "rev-parse",
        "HEAD",
      ]);

      // Corrupting the disposable projection must not prevent the next hook
      // from resolving metadata and committing to the authoritative ledger.
      expect(existsSync(paths.indexPath)).toBeTrue();
      await writeFile(paths.indexPath, "not a sqlite database\n");

      const providerSessionId = "claude-session-stage-zero";
      const providerToolUseId = "toolu_stage_zero_001";
      const hookTarget = join(sourceDirectory, "generated.ts");
      const hookResult = await runClaudeHookProcess({
        session_id: providerSessionId,
        transcript_path: join(root, "claude", "session.jsonl"),
        cwd: sourceDirectory,
        permission_mode: "acceptEdits",
        effort: { level: "high" },
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: {
          file_path: hookTarget,
          content: "PRIVATE_STAGE_ZERO_CONTENT",
        },
        tool_use_id: providerToolUseId,
      });
      expect(hookResult.exitCode).toBe(0);
      expect(hookResult.stdout).toBe("");
      expect(hookResult.stderr).toContain(
        "1 index update failed; run dsp reindex",
      );

      const toolEvents = await sessionLog(created.meta.sid, {
        paths,
        kind: "tool.called",
      });
      expect(toolEvents).toHaveLength(1);
      const toolEvent = toolEvents[0];
      expect(toolEvent).toMatchObject({
        seq: 3,
        src: "hook",
        kind: "tool.called",
        data: {
          name: "Write",
          path: hookTarget,
        },
        ext: {
          claude: {
            hook_event_name: "PreToolUse",
            session_id: providerSessionId,
            permission_mode: "acceptEdits",
            tool_use_id: providerToolUseId,
            effort_level: "high",
            tool_input_keys: ["content", "file_path"],
          },
        },
      });
      expect(Object.keys(toolEvent?.ext ?? {})).toEqual(["claude"]);
      expect(toolEvent?.data).not.toHaveProperty("session_id");
      expect(toolEvent?.data).not.toHaveProperty("tool_use_id");
      expect(JSON.stringify(toolEvent)).not.toContain(
        "PRIVATE_STAGE_ZERO_CONTENT",
      );
      expect(JSON.stringify(toolEvent)).not.toContain("transcript_path");
      expect(JSON.stringify(toolEvent)).not.toContain("\"tool_input\":");

      const merged = await mergeSession(created.meta.sid, {
        paths,
        env: process.env,
      });
      expect(merged.projectionWarnings).toHaveLength(1);
      expect(merged.projectionWarnings[0]).toContain(
        "index projection failed",
      );
      expect(merged.value).toMatchObject({
        repositoryPath: physicalRepositoryPath,
        worktreePath: created.meta.worktreePath,
        sessionBranch: created.meta.branch,
        baseBranch: "main",
        previousHead: initialCommit,
        headCommit: sessionCommit,
        alreadyUpToDate: false,
      });
      expect(await readFile(join(repositoryPath, "src", "stage-zero.txt"), "utf8"))
        .toBe("stage zero lifecycle\n");

      const mergedLog = await sessionLog(created.meta.sid, { paths });
      expect(mergedLog.map((event) => event.kind)).toEqual([
        "session.created",
        "worktree.created",
        "tool.called",
        "git.merged",
        "outcome.recorded",
        "session.closed",
      ]);
      expect(
        mergedLog.find((event) => event.kind === "outcome.recorded")?.data,
      ).toMatchObject({
        disposition: "merged",
        diffstat: {
          files: 1,
          insertions: 1,
          deletions: 0,
          binaryFiles: 0,
        },
        totalCost: 0,
        turnCount: 0,
      });
      expect(mergedLog.at(-1)?.data).toEqual({ reason: "merged" });

      const terminalHook = await runClaudeHookProcess({
        session_id: "claude-session-after-merge",
        transcript_path: join(root, "claude", "after-merge.jsonl"),
        cwd: created.meta.worktreePath,
        permission_mode: "default",
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: {
          file_path: join(created.meta.worktreePath, "README.md"),
        },
        tool_use_id: "toolu_after_merge",
      });
      expect(terminalHook).toEqual({
        exitCode: 0,
        stdout: "",
        stderr: "dispatch hook: 1 index update failed; run dsp reindex\n",
      });
      expect(await sessionLog(created.meta.sid, { paths })).toHaveLength(6);

      const removed = await removeSession(created.meta.sid, false, {
        paths,
        env: process.env,
      });
      expect(removed.projectionWarnings).toHaveLength(1);
      expect(removed.projectionWarnings[0]).toContain(
        "index projection failed",
      );
      expect(removed.value).toEqual({
        repositoryPath: physicalRepositoryPath,
        worktreePath: created.meta.worktreePath,
        forced: false,
        wasDirty: false,
        alreadyAbsent: false,
      });
      expect(existsSync(created.meta.worktreePath)).toBeFalse();
      expect(await readFile(metaPath, "utf8")).toBe(immutableMeta);

      const removalRetry = await removeSession(created.meta.sid, false, {
        paths,
        env: process.env,
      });
      expect(removalRetry.value.alreadyAbsent).toBeTrue();
      expect(await sessionLog(created.meta.sid, { paths })).toHaveLength(7);

      expect(existsSync(paths.indexPath)).toBeTrue();
      await unlink(paths.indexPath);
      await unlink(metaPath);
      expect(existsSync(paths.indexPath)).toBeFalse();
      expect(existsSync(metaPath)).toBeFalse();

      const rebuilt = await reindexSessions({ paths, env: process.env });
      expect(rebuilt).toEqual({ sessions: 1, events: 7 });

      const listed = await listSessions({
        paths,
        env: process.env,
        repositoryPath,
      });
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        sid: created.meta.sid,
        status: "removed",
        lastSeq: 7,
        disposition: "merged",
        diffstat: {
          files: 1,
          insertions: 1,
          deletions: 0,
          binaryFiles: 0,
        },
        totalCost: 0,
        turnCount: 0,
      });

      const rebuiltLog = await sessionLog(created.meta.sid, { paths });
      expect(rebuiltLog.map((event) => event.kind)).toEqual([
        "session.created",
        "worktree.created",
        "tool.called",
        "git.merged",
        "outcome.recorded",
        "session.closed",
        "worktree.removed",
      ]);
      expect(rebuiltLog.map((event) => event.seq)).toEqual([
        1, 2, 3, 4, 5, 6, 7,
      ]);
      expect(
        rebuiltLog.every(
          (event) =>
            event.sid === created.meta.sid && event.mid === created.meta.mid,
        ),
      ).toBeTrue();
      expect(new Set(rebuiltLog.map((event) => event.id)).size).toBe(
        rebuiltLog.length,
      );
      expect(await readFile(metaPath, "utf8")).toBe(immutableMeta);

      await writeFile(paths.indexPath, "not a sqlite database\n");
      const recoveredFromCorruptIndex = await listSessions({
        paths,
        env: process.env,
        repositoryPath,
      });
      expect(recoveredFromCorruptIndex[0]?.lastSeq).toBe(7);

      const reused = await createSession({
        name: "Reused Path",
        repositoryPath,
        worktreePath: created.meta.worktreePath,
        paths,
        env: process.env,
      });
      expect(reused.meta.sid).not.toBe(created.meta.sid);

      const oldGenerationRetry = await removeSession(
        created.meta.sid,
        true,
        { paths, env: process.env },
      );
      expect(oldGenerationRetry.value.alreadyAbsent).toBeTrue();
      expect(existsSync(reused.meta.worktreePath)).toBeTrue();
      expect(await sessionLog(reused.meta.sid, { paths })).toHaveLength(2);

      const reusedHook = await runClaudeHookProcess({
        session_id: "claude-session-reused-path",
        transcript_path: join(root, "claude", "reused.jsonl"),
        cwd: reused.meta.worktreePath,
        permission_mode: "default",
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: join(reused.meta.worktreePath, "README.md") },
        tool_use_id: "toolu_reused_path",
      });
      expect(reusedHook.exitCode).toBe(0);
      expect([
        "",
        "dispatch hook: 1 index update failed; run dsp reindex\n",
      ]).toContain(reusedHook.stderr);
      expect(
        (await sessionLog(reused.meta.sid, { paths })).map(
          (event) => event.kind,
        ),
      ).toEqual([
        "session.created",
        "worktree.created",
        "tool.called",
      ]);
      expect(await sessionLog(created.meta.sid, { paths })).toHaveLength(7);

      await removeSession(reused.meta.sid, false, {
        paths,
        env: process.env,
      });
    } finally {
      restoreEnvironment();
    }
  },
  STAGE_ZERO_TIMEOUT_MS,
);

test.serial(
  "reconciles a Git merge that completed before its ledger receipt",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "dispatch-merge-retry-"));
    fixtureRoots.push(root);
    const restoreEnvironment = pointProcessEnvironmentAt(root);

    try {
      const repositoryPath = await createRepository(root);
      const paths = resolveDispatchPaths(process.env);
      const created = await createSession({
        name: "Merge Retry",
        repositoryPath,
        paths,
        env: process.env,
      });
      const changed = join(created.meta.worktreePath, "retry.txt");
      await writeFile(changed, "merge completed before receipt\n");
      await git(created.meta.worktreePath, ["add", "--", "retry.txt"]);
      await git(created.meta.worktreePath, [
        "commit",
        "-m",
        "prepare merge retry",
      ]);

      await mergeWorktree({
        repositoryPath: created.meta.repositoryPath,
        worktreePath: created.meta.worktreePath,
        sessionBranch: created.meta.branch,
        baseBranch: created.meta.baseBranch,
      });

      const reconciled = await mergeSession(created.meta.sid, {
        paths,
        env: process.env,
      });
      expect(reconciled.value.alreadyUpToDate).toBeTrue();
      const history = await sessionLog(created.meta.sid, { paths });
      expect(
        history.filter((event) => event.kind === "git.merged"),
      ).toHaveLength(1);
      expect(
        history.filter((event) => event.kind === "outcome.recorded"),
      ).toHaveLength(1);
      expect(history.at(-1)?.kind).toBe("session.closed");

      await removeSession(created.meta.sid, false, {
        paths,
        env: process.env,
      });
    } finally {
      restoreEnvironment();
    }
  },
  STAGE_ZERO_TIMEOUT_MS,
);

test.serial(
  "discovers and terminally reconciles an origin-only create intent",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "dispatch-create-intent-"));
    fixtureRoots.push(root);
    const restoreEnvironment = pointProcessEnvironmentAt(root);

    try {
      const repositoryPath = await createRepository(root);
      const paths = resolveDispatchPaths(process.env);
      const sid = createSortableId();
      const planned = await planWorktree({
        repositoryPath,
        worktreePath: join(root, "never-created-worktree"),
        branch: `dispatch-e2e/interrupted-${sid}`,
        baseRef: "main",
      });
      const createdAt = new Date().toISOString();
      await new JsonlLedger({
        eventsPath: sessionEventsPath(paths, sid),
        sessionId: sid,
        machineId: ensureMachineId(paths),
      }).append({
        src: "dsp",
        kind: "session.created",
        data: {
          repositoryPath: planned.repositoryPath,
          worktreePath: planned.worktreePath,
          branch: planned.branch,
          baseBranch: planned.baseBranch,
          baseCommit: planned.baseCommit,
          createdAt,
        },
      });

      const listed = await listSessions({ paths, env: process.env });
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ sid, status: "active", lastSeq: 1 });

      const reconciled = await removeSession(sid, false, {
        paths,
        env: process.env,
      });
      expect(reconciled.value.alreadyAbsent).toBeTrue();
      expect(
        (await sessionLog(sid, { paths })).map((event) => event.kind),
      ).toEqual([
        "session.created",
        "worktree.removed",
        "session.closed",
      ]);
    } finally {
      restoreEnvironment();
    }
  },
  STAGE_ZERO_TIMEOUT_MS,
);
