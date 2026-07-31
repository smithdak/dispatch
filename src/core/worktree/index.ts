import { lstat } from "node:fs/promises";

import {
  normalizeInputPath,
  runGit,
  runGitOrThrow,
  samePath,
  throwGitFailure,
  validateBranchName,
} from "./git";
import {
  WorktreeError,
  type CreatedWorktree,
  type CreateWorktreeInput,
  type DiffWorktreeInput,
  type MergedWorktree,
  type MergeWorktreeInput,
  type PlannedWorktree,
  type RemovedWorktree,
  type RemoveWorktreeInput,
  type RepositoryDiscovery,
  type WorktreeDiff,
  type WorktreeOperation,
} from "./types";

export {
  WorktreeError,
  type CreatedWorktree,
  type CreateWorktreeInput,
  type DiffWorktreeInput,
  type MergedWorktree,
  type MergeWorktreeInput,
  type PlannedWorktree,
  type RemovedWorktree,
  type RemoveWorktreeInput,
  type RepositoryDiscovery,
  type WorktreeDiff,
  type WorktreeErrorCode,
  type WorktreeOperation,
} from "./types";

async function repositoryTopLevelAt(
  cwdInput: string,
  operation: WorktreeOperation,
): Promise<string> {
  const cwd = normalizeInputPath(cwdInput, operation, "cwd");
  const topLevelOutput = await runGit(
    operation,
    cwd,
    cwd,
    ["rev-parse", "--show-toplevel"],
  );
  if (topLevelOutput.exitCode !== 0) {
    throwGitFailure(
      operation,
      "NOT_REPOSITORY",
      cwd,
      `No Git repository contains ${cwd}`,
      topLevelOutput,
    );
  }

  const topLevelText = topLevelOutput.stdout.trim();
  if (topLevelText.length === 0) {
    throw new WorktreeError({
      operation,
      code: "NOT_REPOSITORY",
      path: cwd,
      message: `Git returned no repository top-level for ${cwd}`,
      argv: topLevelOutput.argv,
      exitCode: topLevelOutput.exitCode,
      stderr: topLevelOutput.stderr.trim(),
    });
  }
  const topLevel = normalizeInputPath(
    topLevelText,
    operation,
    "repository top-level",
  );
  return topLevel;
}

async function discoverAt(
  cwdInput: string,
  operation: WorktreeOperation,
): Promise<RepositoryDiscovery> {
  const topLevel = await repositoryTopLevelAt(cwdInput, operation);
  const branchOutput = await runGit(
    operation,
    topLevel,
    topLevel,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
  );
  if (branchOutput.exitCode !== 0 || branchOutput.stdout.trim().length === 0) {
    throwGitFailure(
      operation,
      "DETACHED_HEAD",
      topLevel,
      `Repository at ${topLevel} is not on a local branch`,
      branchOutput,
    );
  }

  return {
    topLevel,
    branch: branchOutput.stdout.trim(),
  };
}

async function pathExists(
  path: string,
  operation: WorktreeOperation,
): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw new WorktreeError({
      operation,
      code: "INVALID_PATH",
      path,
      message: `Could not inspect path ${path}`,
      stderr: error instanceof Error ? error.message : String(error),
    });
  }
}

async function localBranchExists(
  repositoryPath: string,
  branch: string,
  operation: WorktreeOperation,
): Promise<boolean> {
  const output = await runGit(
    operation,
    repositoryPath,
    repositoryPath,
    ["show-ref", "--verify", "--quiet", "--", `refs/heads/${branch}`],
  );
  if (output.exitCode === 0) {
    return true;
  }
  if (output.exitCode === 1) {
    return false;
  }

  throwGitFailure(
    operation,
    "GIT_FAILED",
    repositoryPath,
    `Could not inspect local branch ${branch}`,
    output,
  );
}

async function branchCommit(
  repositoryPath: string,
  branch: string,
  operation: WorktreeOperation,
): Promise<string> {
  // The fixed refs/heads prefix plus prevalidated branch name makes the
  // revision unambiguous. `--end-of-options` closes Git's option parser.
  const output = await runGitOrThrow(
    operation,
    "GIT_FAILED",
    repositoryPath,
    repositoryPath,
    [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `refs/heads/${branch}^{commit}`,
    ],
    `Could not resolve local branch ${branch}`,
  );

  return output.stdout.trim();
}

async function commonGitDirectory(
  repositoryPath: string,
  operation: WorktreeOperation,
): Promise<string> {
  const output = await runGitOrThrow(
    operation,
    "GIT_FAILED",
    repositoryPath,
    repositoryPath,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    `Could not resolve Git common directory for ${repositoryPath}`,
  );

  return normalizeInputPath(
    output.stdout.trim(),
    operation,
    "Git common directory",
  );
}

async function isClean(
  repositoryPath: string,
  operation: WorktreeOperation,
): Promise<{ readonly clean: boolean; readonly argv: readonly string[] }> {
  const output = await runGitOrThrow(
    operation,
    "GIT_FAILED",
    repositoryPath,
    repositoryPath,
    ["status", "--porcelain=v1", "--untracked-files=normal"],
    `Could not read worktree status at ${repositoryPath}`,
  );

  return {
    clean: output.stdout.length === 0,
    argv: output.argv,
  };
}

/**
 * Discover the containing Git worktree and its current local branch.
 */
export async function discoverRepository(
  cwd: string,
): Promise<RepositoryDiscovery> {
  return discoverAt(cwd, "discover");
}

/**
 * Create a new local session branch and linked worktree from an existing
 * local base branch. The returned `baseBranch` is the merge destination that
 * callers persist with session metadata.
 */
export async function planWorktree(
  input: CreateWorktreeInput,
): Promise<PlannedWorktree> {
  const operation = "create";
  const repository = await discoverAt(input.repositoryPath, operation);
  const worktreePath = normalizeInputPath(
    input.worktreePath,
    operation,
    "worktreePath",
  );
  const branch = await validateBranchName(
    repository.topLevel,
    input.branch,
    operation,
    "branch",
    "INVALID_BRANCH",
  );
  const baseBranch = await validateBranchName(
    repository.topLevel,
    input.baseRef,
    operation,
    "baseRef",
    "INVALID_REF",
  );

  if (samePath(repository.topLevel, worktreePath)) {
    throw new WorktreeError({
      operation,
      code: "INVALID_PATH",
      path: worktreePath,
      message: "A linked worktree cannot replace the primary repository",
    });
  }

  if (await pathExists(worktreePath, operation)) {
    throw new WorktreeError({
      operation,
      code: "WORKTREE_PATH_EXISTS",
      path: worktreePath,
      message: `Worktree destination already exists: ${worktreePath}`,
    });
  }

  if (await localBranchExists(repository.topLevel, branch, operation)) {
    throw new WorktreeError({
      operation,
      code: "BRANCH_EXISTS",
      path: repository.topLevel,
      message: `Local branch already exists: ${branch}`,
    });
  }

  if (!(await localBranchExists(repository.topLevel, baseBranch, operation))) {
    throw new WorktreeError({
      operation,
      code: "INVALID_REF",
      path: repository.topLevel,
      message: `Base ref is not an existing local branch: ${baseBranch}`,
    });
  }

  const baseCommit = await branchCommit(
    repository.topLevel,
    baseBranch,
    operation,
  );

  return {
    repositoryPath: repository.topLevel,
    worktreePath,
    branch,
    baseRef: input.baseRef,
    baseBranch,
    baseCommit,
  };
}

/**
 * Apply a previously validated worktree plan. Callers that need durable
 * intent can persist the plan before this external Git mutation.
 */
export async function createPlannedWorktree(
  plan: PlannedWorktree,
): Promise<CreatedWorktree> {
  const operation = "create";
  const addOutput = await runGit(
    operation,
    plan.worktreePath,
    plan.repositoryPath,
    [
      "worktree",
      "add",
      "-b",
      plan.branch,
      "--",
      plan.worktreePath,
      plan.baseCommit,
    ],
  );
  if (addOutput.exitCode !== 0) {
    throwGitFailure(
      operation,
      "CREATE_FAILED",
      plan.worktreePath,
      `Could not create worktree ${plan.worktreePath}`,
      addOutput,
    );
  }

  const created = await discoverAt(plan.worktreePath, operation);
  if (created.branch !== plan.branch) {
    throw new WorktreeError({
      operation,
      code: "CREATE_FAILED",
      path: created.topLevel,
      message:
        `Created worktree is on ${created.branch}; expected session branch ${plan.branch}`,
    });
  }
  const headCommit = await branchCommit(
    plan.repositoryPath,
    plan.branch,
    operation,
  );

  return {
    ...plan,
    worktreePath: created.topLevel,
    headCommit,
  };
}

export async function createWorktree(
  input: CreateWorktreeInput,
): Promise<CreatedWorktree> {
  return createPlannedWorktree(await planWorktree(input));
}

/**
 * Merge a session branch into its recorded base branch.
 *
 * The primary repository branch and cleanliness checks happen before Git is
 * allowed to invoke `merge`.
 */
export async function mergeWorktree(
  input: MergeWorktreeInput,
): Promise<MergedWorktree> {
  const operation = "merge";
  const repository = await discoverAt(input.repositoryPath, operation);
  const worktreePath = normalizeInputPath(
    input.worktreePath,
    operation,
    "worktreePath",
  );
  const sessionBranch = await validateBranchName(
    repository.topLevel,
    input.sessionBranch,
    operation,
    "sessionBranch",
    "INVALID_BRANCH",
  );
  const baseBranch = await validateBranchName(
    repository.topLevel,
    input.baseBranch,
    operation,
    "baseBranch",
    "INVALID_REF",
  );

  if (repository.branch !== baseBranch) {
    throw new WorktreeError({
      operation,
      code: "PRIMARY_BRANCH_MISMATCH",
      path: repository.topLevel,
      message:
        `Primary repository is on ${repository.branch}; recorded base is ${baseBranch}`,
    });
  }

  const primaryStatus = await isClean(repository.topLevel, operation);
  if (!primaryStatus.clean) {
    throw new WorktreeError({
      operation,
      code: "PRIMARY_DIRTY",
      path: repository.topLevel,
      message: `Primary repository is dirty: ${repository.topLevel}`,
      argv: primaryStatus.argv,
    });
  }

  if (!(await localBranchExists(repository.topLevel, sessionBranch, operation))) {
    throw new WorktreeError({
      operation,
      code: "INVALID_REF",
      path: repository.topLevel,
      message: `Session branch does not exist: ${sessionBranch}`,
    });
  }

  const session = await discoverAt(worktreePath, operation);
  if (session.branch !== sessionBranch) {
    throw new WorktreeError({
      operation,
      code: "SESSION_BRANCH_MISMATCH",
      path: session.topLevel,
      message:
        `Session worktree is on ${session.branch}; expected ${sessionBranch}`,
    });
  }

  const [primaryCommonDirectory, sessionCommonDirectory] = await Promise.all([
    commonGitDirectory(repository.topLevel, operation),
    commonGitDirectory(session.topLevel, operation),
  ]);
  if (!samePath(primaryCommonDirectory, sessionCommonDirectory)) {
    throw new WorktreeError({
      operation,
      code: "WORKTREE_REPOSITORY_MISMATCH",
      path: session.topLevel,
      message:
        `Session worktree ${session.topLevel} does not belong to ${repository.topLevel}`,
    });
  }

  const sessionStatus = await isClean(session.topLevel, operation);
  if (!sessionStatus.clean) {
    throw new WorktreeError({
      operation,
      code: "WORKTREE_DIRTY",
      path: session.topLevel,
      message:
        `Session worktree is dirty; commit or discard its changes before merge: ${session.topLevel}`,
      argv: sessionStatus.argv,
    });
  }

  const sessionHeadCommit = await branchCommit(
    repository.topLevel,
    sessionBranch,
    operation,
  );
  const previousHead = await branchCommit(
    repository.topLevel,
    baseBranch,
    operation,
  );
  const mergeOutput = await runGit(
    operation,
    repository.topLevel,
    repository.topLevel,
    ["merge", "--no-edit", "--", sessionBranch],
  );
  if (mergeOutput.exitCode !== 0) {
    throwGitFailure(
      operation,
      "MERGE_FAILED",
      repository.topLevel,
      `Could not merge ${sessionBranch} into ${baseBranch}`,
      mergeOutput,
    );
  }
  const headCommit = await branchCommit(
    repository.topLevel,
    baseBranch,
    operation,
  );

  return {
    repositoryPath: repository.topLevel,
    worktreePath: session.topLevel,
    sessionBranch,
    baseBranch,
    previousHead,
    sessionHeadCommit,
    headCommit,
    alreadyUpToDate: previousHead === headCommit,
  };
}

/**
 * Remove a linked worktree. Dirty worktrees are rejected unless `force` is
 * explicitly true, in which case one `--force` flag is passed to Git.
 */
export async function removeWorktree(
  input: RemoveWorktreeInput,
): Promise<RemovedWorktree> {
  const operation = "remove";
  const repository = await discoverAt(input.repositoryPath, operation);
  const worktreePath = normalizeInputPath(
    input.worktreePath,
    operation,
    "worktreePath",
  );
  const force = input.force === true;
  const expectedBranch = await validateBranchName(
    repository.topLevel,
    input.expectedBranch,
    operation,
    "expectedBranch",
    "INVALID_BRANCH",
  );

  if (samePath(repository.topLevel, worktreePath)) {
    throw new WorktreeError({
      operation,
      code: "INVALID_PATH",
      path: worktreePath,
      message: "The primary repository cannot be removed as a linked worktree",
    });
  }

  if (!(await pathExists(worktreePath, operation))) {
    throw new WorktreeError({
      operation,
      code: "WORKTREE_NOT_FOUND",
      path: worktreePath,
      message: `Worktree does not exist: ${worktreePath}`,
    });
  }

  const session = await discoverAt(worktreePath, operation);
  if (session.branch !== expectedBranch) {
    throw new WorktreeError({
      operation,
      code: "SESSION_BRANCH_MISMATCH",
      path: session.topLevel,
      message:
        `Worktree is on ${session.branch}; expected session branch ${expectedBranch}`,
    });
  }
  const [primaryCommonDirectory, sessionCommonDirectory] = await Promise.all([
    commonGitDirectory(repository.topLevel, operation),
    commonGitDirectory(session.topLevel, operation),
  ]);
  if (!samePath(primaryCommonDirectory, sessionCommonDirectory)) {
    throw new WorktreeError({
      operation,
      code: "WORKTREE_REPOSITORY_MISMATCH",
      path: session.topLevel,
      message:
        `Worktree ${session.topLevel} does not belong to ${repository.topLevel}`,
    });
  }

  const sessionStatus = await isClean(session.topLevel, operation);
  if (!sessionStatus.clean && !force) {
    throw new WorktreeError({
      operation,
      code: "WORKTREE_DIRTY",
      path: session.topLevel,
      message:
        `Worktree is dirty; removal requires force=true: ${session.topLevel}`,
      argv: sessionStatus.argv,
    });
  }

  const args = [
    "worktree",
    "remove",
    ...(force ? ["--force"] : []),
    "--",
    session.topLevel,
  ];
  const removeOutput = await runGit(
    operation,
    session.topLevel,
    repository.topLevel,
    args,
  );
  if (removeOutput.exitCode !== 0) {
    throwGitFailure(
      operation,
      "REMOVE_FAILED",
      session.topLevel,
      `Could not remove worktree ${session.topLevel}`,
      removeOutput,
    );
  }

  return {
    repositoryPath: repository.topLevel,
    worktreePath: session.topLevel,
    forced: force,
    wasDirty: !sessionStatus.clean,
    alreadyAbsent: false,
  };
}

const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const NUMSTAT_COUNT = /^(?:0|[1-9][0-9]*)$/;

function validateObjectId(
  repositoryPath: string,
  value: string,
  field: "fromCommit" | "toCommit",
): string {
  if (typeof value !== "string" || !FULL_OBJECT_ID.test(value)) {
    throw new WorktreeError({
      operation: "diff",
      code: "INVALID_OBJECT_ID",
      path: repositoryPath,
      message:
        `${field} must be a full 40- or 64-character hexadecimal object ID`,
    });
  }

  return value.toLowerCase();
}

async function verifyCommitObject(
  repositoryPath: string,
  objectId: string,
  field: "fromCommit" | "toCommit",
): Promise<void> {
  // The caller-provided portion is already a full hexadecimal object ID.
  // The peel suffix is ours, so arbitrary revision syntax cannot cross this
  // boundary.
  const output = await runGit(
    "diff",
    repositoryPath,
    repositoryPath,
    [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${objectId}^{commit}`,
    ],
  );
  if (output.exitCode !== 0) {
    throw new WorktreeError({
      operation: "diff",
      code: "OBJECT_NOT_COMMIT",
      path: repositoryPath,
      message: `${field} does not resolve to a commit object: ${objectId}`,
      argv: output.argv,
      exitCode: output.exitCode,
      stderr: output.stderr.trim(),
    });
  }
}

function invalidDiffOutput(
  repositoryPath: string,
  message: string,
  argv: readonly string[],
): never {
  throw new WorktreeError({
    operation: "diff",
    code: "INVALID_DIFF_OUTPUT",
    path: repositoryPath,
    message,
    argv,
  });
}

function parseNumstat(
  repositoryPath: string,
  stdout: string,
  argv: readonly string[],
): Omit<WorktreeDiff, "repositoryPath"> {
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  let binaryFiles = 0;

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) continue;

    const firstTab = line.indexOf("\t");
    const secondTab = line.indexOf("\t", firstTab + 1);
    if (firstTab <= 0 || secondTab <= firstTab + 1) {
      invalidDiffOutput(
        repositoryPath,
        "Git produced a malformed --numstat line",
        argv,
      );
    }

    const added = line.slice(0, firstTab);
    const deleted = line.slice(firstTab + 1, secondTab);
    files += 1;

    if (added === "-" || deleted === "-") {
      binaryFiles += 1;
      continue;
    }

    if (!NUMSTAT_COUNT.test(added) || !NUMSTAT_COUNT.test(deleted)) {
      invalidDiffOutput(
        repositoryPath,
        "Git produced a non-numeric --numstat count",
        argv,
      );
    }

    const addedCount = Number(added);
    const deletedCount = Number(deleted);
    if (
      !Number.isSafeInteger(addedCount) ||
      !Number.isSafeInteger(deletedCount) ||
      !Number.isSafeInteger(insertions + addedCount) ||
      !Number.isSafeInteger(deletions + deletedCount)
    ) {
      invalidDiffOutput(
        repositoryPath,
        "Git produced a --numstat count outside the safe integer range",
        argv,
      );
    }

    insertions += addedCount;
    deletions += deletedCount;
  }

  return { files, insertions, deletions, binaryFiles };
}

/**
 * Summarize the committed diff between two immutable object IDs.
 *
 * This API never reads the working tree and accepts no revision expressions,
 * abbreviated hashes, or pathspecs.
 */
export async function diffWorktree(
  input: DiffWorktreeInput,
): Promise<WorktreeDiff> {
  const repositoryPath = await repositoryTopLevelAt(
    input.repositoryPath,
    "diff",
  );
  const fromCommit = validateObjectId(
    repositoryPath,
    input.fromCommit,
    "fromCommit",
  );
  const toCommit = validateObjectId(
    repositoryPath,
    input.toCommit,
    "toCommit",
  );

  await verifyCommitObject(repositoryPath, fromCommit, "fromCommit");
  await verifyCommitObject(repositoryPath, toCommit, "toCommit");

  const output = await runGit(
    "diff",
    repositoryPath,
    repositoryPath,
    [
      "diff",
      "--numstat",
      "--find-renames",
      `${fromCommit}..${toCommit}`,
      "--",
    ],
  );
  if (output.exitCode !== 0) {
    throwGitFailure(
      "diff",
      "DIFF_FAILED",
      repositoryPath,
      `Could not diff commits ${fromCommit} and ${toCommit}`,
      output,
    );
  }

  return {
    repositoryPath,
    ...parseNumstat(repositoryPath, output.stdout, output.argv),
  };
}
