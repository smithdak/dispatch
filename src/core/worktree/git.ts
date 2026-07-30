import { resolve } from "node:path";

import {
  WorktreeError,
  type WorktreeErrorCode,
  type WorktreeOperation,
} from "./types";

export interface GitOutput {
  readonly argv: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const UNSAFE_INPUT = /[\0\r\n]/;

export function normalizeInputPath(
  input: string,
  operation: WorktreeOperation,
  field: string,
): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.trim().length === 0 ||
    UNSAFE_INPUT.test(input)
  ) {
    throw new WorktreeError({
      operation,
      code: "INVALID_PATH",
      path: typeof input === "string" && input.length > 0 ? input : "<empty>",
      message: `${field} must be a non-empty path without NUL or newline characters`,
    });
  }

  return resolve(input);
}

export async function runGit(
  operation: WorktreeOperation,
  anchorPath: string,
  cwd: string,
  args: readonly string[],
): Promise<GitOutput> {
  const argv = ["git", "-C", cwd, ...args];

  let subprocess: ReturnType<typeof Bun.spawn>;
  try {
    subprocess = Bun.spawn({
      cmd: argv,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (cause) {
    const stderr = cause instanceof Error ? cause.message : String(cause);
    throw new WorktreeError({
      operation,
      code: "GIT_SPAWN_FAILED",
      path: anchorPath,
      message: `Could not start git for ${operation}`,
      argv,
      stderr,
    });
  }

  const stdoutPromise = new Response(
    subprocess.stdout as unknown as BodyInit,
  ).text();
  const stderrPromise = new Response(
    subprocess.stderr as unknown as BodyInit,
  ).text();
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    stdoutPromise,
    stderrPromise,
  ]);

  return {
    argv: Object.freeze(argv),
    exitCode,
    stdout,
    stderr,
  };
}

export function throwGitFailure(
  operation: WorktreeOperation,
  code: WorktreeErrorCode,
  path: string,
  message: string,
  output: GitOutput,
): never {
  throw new WorktreeError({
    operation,
    code,
    path,
    message,
    argv: output.argv,
    exitCode: output.exitCode,
    stderr: output.stderr.trim(),
  });
}

export async function runGitOrThrow(
  operation: WorktreeOperation,
  code: WorktreeErrorCode,
  anchorPath: string,
  cwd: string,
  args: readonly string[],
  message: string,
): Promise<GitOutput> {
  const output = await runGit(operation, anchorPath, cwd, args);
  if (output.exitCode !== 0) {
    throwGitFailure(operation, code, anchorPath, message, output);
  }

  return output;
}

export async function validateBranchName(
  repositoryPath: string,
  name: string,
  operation: WorktreeOperation,
  field: string,
  code: "INVALID_BRANCH" | "INVALID_REF",
): Promise<string> {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name !== name.trim() ||
    name.startsWith("-") ||
    UNSAFE_INPUT.test(name)
  ) {
    throw new WorktreeError({
      operation,
      code,
      path: repositoryPath,
      message: `${field} is not a safe branch name`,
    });
  }

  // `check-ref-format --branch` has no positional `--` form. The lexical
  // leading-dash check above prevents option injection before this call.
  const output = await runGit(
    operation,
    repositoryPath,
    repositoryPath,
    ["check-ref-format", "--branch", name],
  );
  const normalized = output.stdout.trim();
  if (output.exitCode !== 0 || normalized !== name) {
    throw new WorktreeError({
      operation,
      code,
      path: repositoryPath,
      message: `${field} is not a valid, literal local branch name`,
      argv: output.argv,
      exitCode: output.exitCode,
      stderr: output.stderr.trim(),
    });
  }

  return normalized;
}

export function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  if (process.platform === "win32") {
    return normalizedLeft.toLocaleLowerCase("en-US") ===
      normalizedRight.toLocaleLowerCase("en-US");
  }

  return normalizedLeft === normalizedRight;
}
