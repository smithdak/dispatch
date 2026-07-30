export type WorktreeOperation =
  | "discover"
  | "create"
  | "merge"
  | "remove"
  | "diff";

export type WorktreeErrorCode =
  | "INVALID_PATH"
  | "INVALID_BRANCH"
  | "INVALID_REF"
  | "INVALID_OBJECT_ID"
  | "OBJECT_NOT_COMMIT"
  | "NOT_REPOSITORY"
  | "DETACHED_HEAD"
  | "BRANCH_EXISTS"
  | "WORKTREE_PATH_EXISTS"
  | "WORKTREE_NOT_FOUND"
  | "WORKTREE_REPOSITORY_MISMATCH"
  | "PRIMARY_BRANCH_MISMATCH"
  | "PRIMARY_DIRTY"
  | "SESSION_BRANCH_MISMATCH"
  | "WORKTREE_DIRTY"
  | "GIT_SPAWN_FAILED"
  | "GIT_FAILED"
  | "CREATE_FAILED"
  | "MERGE_FAILED"
  | "REMOVE_FAILED"
  | "DIFF_FAILED"
  | "INVALID_DIFF_OUTPUT";

export interface WorktreeErrorInit {
  readonly operation: WorktreeOperation;
  readonly code: WorktreeErrorCode;
  readonly path: string;
  readonly message: string;
  readonly argv?: readonly string[];
  readonly exitCode?: number;
  readonly stderr?: string;
}

/**
 * A stable, path-anchored failure raised by the git worktree boundary.
 *
 * `argv` is retained as an array so callers can render evidence without
 * reconstructing (and potentially misquoting) a shell command.
 */
export class WorktreeError extends Error {
  readonly operation: WorktreeOperation;
  readonly code: WorktreeErrorCode;
  readonly path: string;
  readonly argv: readonly string[];
  readonly exitCode: number | undefined;
  readonly stderr: string | undefined;

  constructor(init: WorktreeErrorInit) {
    super(init.message);
    this.name = "WorktreeError";
    this.operation = init.operation;
    this.code = init.code;
    this.path = init.path;
    this.argv = Object.freeze([...(init.argv ?? [])]);
    this.exitCode = init.exitCode;
    this.stderr = init.stderr;
  }
}

export interface RepositoryDiscovery {
  /** Absolute top-level path of the current Git worktree. */
  readonly topLevel: string;
  /** Short local branch name. Detached HEAD is returned as an error. */
  readonly branch: string;
}

export interface CreateWorktreeInput {
  /** Any path inside the primary repository. */
  readonly repositoryPath: string;
  /** Destination for the new linked worktree. */
  readonly worktreePath: string;
  /** New local session branch to create. */
  readonly branch: string;
  /** Existing local branch recorded as this session's merge destination. */
  readonly baseRef: string;
}

export interface PlannedWorktree {
  readonly repositoryPath: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseRef: string;
  readonly baseBranch: string;
  readonly baseCommit: string;
}

export interface CreatedWorktree extends PlannedWorktree {
  readonly headCommit: string;
}

export interface MergeWorktreeInput {
  /** Any path inside the primary repository worktree. */
  readonly repositoryPath: string;
  /** Path to the session's linked worktree. */
  readonly worktreePath: string;
  /** Local branch owned by the session worktree. */
  readonly sessionBranch: string;
  /** Base branch recorded when the session worktree was created. */
  readonly baseBranch: string;
}

export interface MergedWorktree {
  readonly repositoryPath: string;
  readonly worktreePath: string;
  readonly sessionBranch: string;
  readonly baseBranch: string;
  readonly previousHead: string;
  readonly sessionHeadCommit: string;
  readonly headCommit: string;
  readonly alreadyUpToDate: boolean;
}

export interface RemoveWorktreeInput {
  /** Any path inside the primary repository worktree. */
  readonly repositoryPath: string;
  /** Linked worktree to remove. */
  readonly worktreePath: string;
  /** Session branch that must still own the linked worktree. */
  readonly expectedBranch: string;
  /** Explicitly permit removal when the linked worktree is dirty. */
  readonly force?: boolean;
}

export interface RemovedWorktree {
  readonly repositoryPath: string;
  readonly worktreePath: string;
  readonly forced: boolean;
  readonly wasDirty: boolean;
  readonly alreadyAbsent: boolean;
}

export interface DiffWorktreeInput {
  /** Any path inside the repository containing both persisted commits. */
  readonly repositoryPath: string;
  /** Full SHA-1 or SHA-256 object ID for the immutable base commit. */
  readonly fromCommit: string;
  /** Full SHA-1 or SHA-256 object ID for the immutable target commit. */
  readonly toCommit: string;
}

export interface WorktreeDiff {
  readonly repositoryPath: string;
  readonly files: number;
  readonly insertions: number;
  readonly deletions: number;
  readonly binaryFiles: number;
}
