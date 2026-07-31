import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WorktreeError,
  createWorktree,
  diffWorktree,
  discoverRepository,
  mergeWorktree,
  removeWorktree,
} from "../../src/core/worktree";

interface Fixture {
  readonly root: string;
  readonly repositoryPath: string;
  readonly physicalRoot: string;
  readonly physicalRepositoryPath: string;
}

const fixtureRoots: string[] = [];
const GIT_TEST_TIMEOUT_MS = 20_000;

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

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "dispatch-worktree-"));
  fixtureRoots.push(root);
  const repositoryPath = join(root, "repository");
  await mkdir(repositoryPath);
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
  await writeFile(join(repositoryPath, "README.md"), "# fixture\n");
  await git(repositoryPath, ["add", "--", "README.md"]);
  await git(repositoryPath, ["commit", "-m", "initial"]);

  return {
    root,
    repositoryPath,
    physicalRoot: await realpath(root),
    physicalRepositoryPath: await realpath(repositoryPath),
  };
}

async function expectWorktreeError(
  promise: Promise<unknown>,
): Promise<WorktreeError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(WorktreeError);
    return error as WorktreeError;
  }

  throw new Error("Expected a WorktreeError");
}

afterEach(async () => {
  const roots = fixtureRoots.splice(0);
  await Promise.all(
    roots.map((root) =>
      rm(root, { recursive: true, force: true, maxRetries: 3 })
    ),
  );
});

describe("git worktree boundary", () => {
  test(
    "discovers, creates, merges, and removes an isolated worktree",
    async () => {
      const fixture = await createFixture();
      const discovery = await discoverRepository(fixture.repositoryPath);
      expect(discovery).toEqual({
        topLevel: fixture.physicalRepositoryPath,
        branch: "main",
      });

      const created = await createWorktree({
        repositoryPath: fixture.repositoryPath,
        worktreePath: join(fixture.root, "--session-worktree"),
        branch: "session/complete",
        baseRef: "main",
      });
      expect(created).toMatchObject({
        repositoryPath: fixture.physicalRepositoryPath,
        worktreePath: join(fixture.physicalRoot, "--session-worktree"),
        branch: "session/complete",
        baseRef: "main",
        baseBranch: "main",
      });
      expect(created.baseCommit).toBe(created.headCommit);

      await writeFile(join(created.worktreePath, "session.txt"), "merged\n");
      await git(created.worktreePath, ["add", "--", "session.txt"]);
      await git(created.worktreePath, ["commit", "-m", "session change"]);

      const merged = await mergeWorktree({
        repositoryPath: created.repositoryPath,
        worktreePath: created.worktreePath,
        sessionBranch: created.branch,
        baseBranch: created.baseBranch,
      });
      expect(merged.alreadyUpToDate).toBe(false);
      expect(merged.headCommit).not.toBe(merged.previousHead);
      expect(
        await readFile(join(fixture.repositoryPath, "session.txt"), "utf8"),
      ).toBe("merged\n");

      const removed = await removeWorktree({
        repositoryPath: fixture.repositoryPath,
        worktreePath: created.worktreePath,
        expectedBranch: created.branch,
        force: false,
      });
      expect(removed).toEqual({
        repositoryPath: fixture.physicalRepositoryPath,
        worktreePath: join(fixture.physicalRoot, "--session-worktree"),
        forced: false,
        wasDirty: false,
        alreadyAbsent: false,
      });
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "summarizes committed text, rename, and binary changes",
    async () => {
      const fixture = await createFixture();
      const fromCommit = await git(fixture.repositoryPath, [
        "rev-parse",
        "HEAD",
      ]);

      await rename(
        join(fixture.repositoryPath, "README.md"),
        join(fixture.repositoryPath, "RENAMED.md"),
      );
      await writeFile(join(fixture.repositoryPath, "notes.txt"), "one\ntwo\n");
      await writeFile(
        join(fixture.repositoryPath, "binary.bin"),
        new Uint8Array([0, 1, 2, 3]),
      );
      await git(fixture.repositoryPath, ["add", "--all", "--"]);
      await git(fixture.repositoryPath, ["commit", "-m", "mixed diff"]);
      const toCommit = await git(fixture.repositoryPath, [
        "rev-parse",
        "HEAD",
      ]);

      const summary = await diffWorktree({
        repositoryPath: fixture.repositoryPath,
        fromCommit,
        toCommit,
      });
      expect(summary).toEqual({
        repositoryPath: fixture.physicalRepositoryPath,
        files: 3,
        insertions: 2,
        deletions: 0,
        binaryFiles: 1,
      });
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "rejects revision syntax and full object IDs that are not commits",
    async () => {
      const fixture = await createFixture();
      const commit = await git(fixture.repositoryPath, ["rev-parse", "HEAD"]);

      const syntaxError = await expectWorktreeError(
        diffWorktree({
          repositoryPath: fixture.repositoryPath,
          fromCommit: "HEAD",
          toCommit: commit,
        }),
      );
      expect(syntaxError).toMatchObject({
        operation: "diff",
        code: "INVALID_OBJECT_ID",
        path: fixture.physicalRepositoryPath,
        argv: [],
      });

      const blob = await git(fixture.repositoryPath, [
        "rev-parse",
        "HEAD:README.md",
      ]);
      const objectError = await expectWorktreeError(
        diffWorktree({
          repositoryPath: fixture.repositoryPath,
          fromCommit: blob,
          toCommit: commit,
        }),
      );
      expect(objectError).toMatchObject({
        operation: "diff",
        code: "OBJECT_NOT_COMMIT",
        path: fixture.physicalRepositoryPath,
      });
      expect(objectError.argv.at(-1)).toBe(`${blob}^{commit}`);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "rejects merge when the primary repository is dirty",
    async () => {
      const fixture = await createFixture();
      const created = await createWorktree({
        repositoryPath: fixture.repositoryPath,
        worktreePath: join(fixture.root, "dirty-primary-session"),
        branch: "session/dirty-primary",
        baseRef: "main",
      });
      await writeFile(join(fixture.repositoryPath, "untracked.txt"), "dirty\n");

      const error = await expectWorktreeError(
        mergeWorktree({
          repositoryPath: fixture.repositoryPath,
          worktreePath: created.worktreePath,
          sessionBranch: created.branch,
          baseBranch: created.baseBranch,
        }),
      );
      expect(error).toMatchObject({
        operation: "merge",
        code: "PRIMARY_DIRTY",
        path: fixture.physicalRepositoryPath,
      });
      expect(error.argv).toEqual([
        "git",
        "-C",
        fixture.physicalRepositoryPath,
        "status",
        "--porcelain=v1",
        "--untracked-files=normal",
      ]);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "rejects merge when the session worktree has uncommitted changes",
    async () => {
      const fixture = await createFixture();
      const created = await createWorktree({
        repositoryPath: fixture.repositoryPath,
        worktreePath: join(fixture.root, "dirty-session-merge"),
        branch: "session/dirty-session-merge",
        baseRef: "main",
      });
      await writeFile(
        join(created.worktreePath, "uncommitted.txt"),
        "not represented by the session branch\n",
      );

      const error = await expectWorktreeError(
        mergeWorktree({
          repositoryPath: fixture.repositoryPath,
          worktreePath: created.worktreePath,
          sessionBranch: created.branch,
          baseBranch: created.baseBranch,
        }),
      );
      expect(error).toMatchObject({
        operation: "merge",
        code: "WORKTREE_DIRTY",
        path: join(fixture.physicalRoot, "dirty-session-merge"),
      });
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "rejects merge when the primary repository left the recorded base",
    async () => {
      const fixture = await createFixture();
      const created = await createWorktree({
        repositoryPath: fixture.repositoryPath,
        worktreePath: join(fixture.root, "wrong-branch-session"),
        branch: "session/wrong-branch",
        baseRef: "main",
      });
      await git(fixture.repositoryPath, ["switch", "-c", "other"]);

      const error = await expectWorktreeError(
        mergeWorktree({
          repositoryPath: fixture.repositoryPath,
          worktreePath: created.worktreePath,
          sessionBranch: created.branch,
          baseBranch: created.baseBranch,
        }),
      );
      expect(error).toMatchObject({
        operation: "merge",
        code: "PRIMARY_BRANCH_MISMATCH",
        path: fixture.physicalRepositoryPath,
      });
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "requires explicit force to remove a dirty worktree",
    async () => {
      const fixture = await createFixture();
      const created = await createWorktree({
        repositoryPath: fixture.repositoryPath,
        worktreePath: join(fixture.root, "dirty-session"),
        branch: "session/dirty-remove",
        baseRef: "main",
      });
      await writeFile(join(created.worktreePath, "untracked.txt"), "dirty\n");

      const error = await expectWorktreeError(
        removeWorktree({
          repositoryPath: fixture.repositoryPath,
          worktreePath: created.worktreePath,
          expectedBranch: created.branch,
          force: false,
        }),
      );
      expect(error).toMatchObject({
        operation: "remove",
        code: "WORKTREE_DIRTY",
        path: join(fixture.physicalRoot, "dirty-session"),
      });

      const removed = await removeWorktree({
        repositoryPath: fixture.repositoryPath,
        worktreePath: created.worktreePath,
        expectedBranch: created.branch,
        force: true,
      });
      expect(removed.forced).toBe(true);
      expect(removed.wasDirty).toBe(true);
      expect(removed.alreadyAbsent).toBe(false);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "refuses to remove a worktree owned by another session branch",
    async () => {
      const fixture = await createFixture();
      const created = await createWorktree({
        repositoryPath: fixture.repositoryPath,
        worktreePath: join(fixture.root, "branch-owned-session"),
        branch: "session/branch-owner",
        baseRef: "main",
      });

      const error = await expectWorktreeError(
        removeWorktree({
          repositoryPath: fixture.repositoryPath,
          worktreePath: created.worktreePath,
          expectedBranch: "session/different-owner",
          force: true,
        }),
      );
      expect(error).toMatchObject({
        operation: "remove",
        code: "SESSION_BRANCH_MISMATCH",
        path: join(fixture.physicalRoot, "branch-owned-session"),
      });
      expect(existsSync(created.worktreePath)).toBeTrue();
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "rejects option-shaped branch and base-ref inputs before mutation",
    async () => {
      const fixture = await createFixture();

      const branchError = await expectWorktreeError(
        createWorktree({
          repositoryPath: fixture.repositoryPath,
          worktreePath: join(fixture.root, "invalid-branch"),
          branch: "--force",
          baseRef: "main",
        }),
      );
      expect(branchError).toMatchObject({
        operation: "create",
        code: "INVALID_BRANCH",
        path: fixture.physicalRepositoryPath,
      });

      const refError = await expectWorktreeError(
        createWorktree({
          repositoryPath: fixture.repositoryPath,
          worktreePath: join(fixture.root, "invalid-ref"),
          branch: "session/valid",
          baseRef: "--help",
        }),
      );
      expect(refError).toMatchObject({
        operation: "create",
        code: "INVALID_REF",
        path: fixture.physicalRepositoryPath,
      });
    },
    GIT_TEST_TIMEOUT_MS,
  );
});
