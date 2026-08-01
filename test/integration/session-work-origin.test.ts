import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSession,
  removeSession,
  sessionLog,
} from "../../src/application/sessions";
import { readSessionMeta } from "../../src/application/session-meta";
import { createSortableId } from "../../src/core/identity";
import { resolveDispatchPaths } from "../../src/core/paths";

const fixtureRoots: string[] = [];
const TEST_TIMEOUT_MS = 30_000;

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const argv = ["git", "-C", cwd, ...args];
  const subprocess = Bun.spawn({
    cmd: argv,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${JSON.stringify(argv)} failed (${exitCode}): ${stderr.trim()}`,
    );
  }
  return stdout.trim();
}

async function createFixture(): Promise<{
  root: string;
  repositoryPath: string;
  env: Readonly<Record<string, string>>;
  paths: ReturnType<typeof resolveDispatchPaths>;
}> {
  const root = await mkdtemp(join(tmpdir(), "dispatch-work-origin-"));
  fixtureRoots.push(root);
  const home = join(root, "home");
  const env = {
    HOME: home,
    USERPROFILE: home,
    DISPATCH_HOME: join(root, "dispatch-state"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_CACHE_HOME: join(root, "xdg-cache"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    DISPATCH_WORKTREE_ROOT: join(root, "worktrees"),
    DISPATCH_BRANCH_PREFIX: "dispatch-test/",
  } as const;
  const paths = resolveDispatchPaths(env);
  const repositoryPath = join(root, "repository");

  await mkdir(repositoryPath, { recursive: true });
  await git(root, ["init", "--initial-branch=main", "--", repositoryPath]);
  await git(repositoryPath, ["config", "user.name", "Dispatch Tests"]);
  await git(repositoryPath, [
    "config",
    "user.email",
    "dispatch-tests@example.invalid",
  ]);
  await git(repositoryPath, ["config", "core.autocrlf", "false"]);
  await writeFile(join(repositoryPath, "README.md"), "# Work origin fixture\n");
  await git(repositoryPath, ["add", "--", "README.md"]);
  await git(repositoryPath, ["commit", "-m", "initial"]);

  return { root, repositoryPath, env, paths };
}

async function gitState(repositoryPath: string): Promise<{
  head: string;
  branches: string;
  status: string;
  worktrees: string;
}> {
  const [head, branches, status, worktrees] = await Promise.all([
    git(repositoryPath, ["rev-parse", "HEAD"]),
    git(repositoryPath, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/heads",
    ]),
    git(repositoryPath, ["status", "--porcelain=v1", "--untracked-files=all"]),
    git(repositoryPath, ["worktree", "list", "--porcelain"]),
  ]);
  return { head, branches, status, worktrees };
}

function fixedSortableId(timestamp: number, byte: number): string {
  return createSortableId({
    timestamp,
    randomBytes: (length) => new Uint8Array(length).fill(byte),
  });
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
  "uses an explicit session ID and records work origin without changing metadata",
  async () => {
    const { root, repositoryPath, env, paths } = await createFixture();
    const sessionId = fixedSortableId(1_800_000_000_000, 1);
    const workId = fixedSortableId(1_800_000_000_001, 2);

    const created = await createSession({
      sessionId,
      workId,
      name: "Work Origin",
      repositoryPath,
      worktreePath: join(root, "worktree"),
      paths,
      env,
    });

    expect(created.meta.sid).toBe(sessionId);
    expect(created.value).toEqual(created.meta);
    expect(created.meta).not.toHaveProperty("workId");

    const history = await sessionLog(sessionId, { paths });
    expect(history[0]).toMatchObject({
      sid: sessionId,
      seq: 1,
      src: "dsp",
      kind: "session.created",
      data: { workId },
    });

    const metaPath = join(paths.sessionsDir, sessionId, "meta.json");
    const persistedMeta = JSON.parse(await readFile(metaPath, "utf8")) as unknown;
    expect(persistedMeta).toEqual(created.meta);
    expect(persistedMeta).not.toHaveProperty("workId");

    await unlink(metaPath);
    const recoveredMeta = readSessionMeta(paths, sessionId);
    expect(recoveredMeta).toEqual(created.meta);
    expect(recoveredMeta).not.toHaveProperty("workId");

    await removeSession(sessionId, false, { paths, env });
  },
  TEST_TIMEOUT_MS,
);

test.serial(
  "rejects invalid supplied IDs before filesystem or Git mutation",
  async () => {
    const { root, repositoryPath, env, paths } = await createFixture();
    const initialGitState = await gitState(repositoryPath);
    const validSessionId = fixedSortableId(1_800_000_000_002, 3);

    expect(existsSync(paths.stateDir)).toBeFalse();

    await expect(
      createSession({
        sessionId: "not-a-sortable-id",
        name: "Invalid Session ID",
        repositoryPath,
        worktreePath: join(root, "invalid-session-worktree"),
        paths,
        env,
      }),
    ).rejects.toThrow("sessionId must be a canonical sortable ID");
    expect(existsSync(paths.stateDir)).toBeFalse();
    expect(await gitState(repositoryPath)).toEqual(initialGitState);

    await expect(
      createSession({
        sessionId: validSessionId,
        workId: "not-a-sortable-id",
        name: "Invalid Work ID",
        repositoryPath,
        worktreePath: join(root, "invalid-work-worktree"),
        paths,
        env,
      }),
    ).rejects.toThrow("workId must be a canonical sortable ID");
    expect(existsSync(paths.stateDir)).toBeFalse();
    expect(await gitState(repositoryPath)).toEqual(initialGitState);
  },
  TEST_TIMEOUT_MS,
);

test.serial(
  "rejects reuse of a supplied session ID before ledger or Git mutation",
  async () => {
    const { root, repositoryPath, env, paths } = await createFixture();
    const sessionId = fixedSortableId(1_800_000_000_003, 4);
    const firstWorktree = join(root, "first-worktree");
    const secondWorktree = join(root, "second-worktree");

    await createSession({
      sessionId,
      name: "First Owner",
      repositoryPath,
      worktreePath: firstWorktree,
      paths,
      env,
    });
    const historyBefore = await sessionLog(sessionId, { paths });
    const gitBefore = await gitState(repositoryPath);

    await expect(
      createSession({
        sessionId,
        name: "Second Owner",
        repositoryPath,
        worktreePath: secondWorktree,
        paths,
        env,
      }),
    ).rejects.toMatchObject({ code: "session.id_exists" });

    expect(await sessionLog(sessionId, { paths })).toEqual(historyBefore);
    expect(await gitState(repositoryPath)).toEqual(gitBefore);
    expect(existsSync(secondWorktree)).toBeFalse();

    await removeSession(sessionId, false, { paths, env });
  },
  TEST_TIMEOUT_MS,
);
