import { randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 10;
const DEFAULT_STALE_AFTER_MS = 30_000;
const REAPER_PUBLICATION_GRACE_MS = 100;

interface LockOwner {
  readonly token: string;
  readonly pid: number;
  readonly hostname: string;
  readonly createdAt: string;
}

interface ResolvedLockOptions {
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  readonly staleAfterMs: number;
  readonly signal: AbortSignal | undefined;
}

export interface ExclusiveFileLockOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly staleAfterMs?: number;
  readonly signal?: AbortSignal;
}

export class LockTimeoutError extends Error {
  readonly lockPath: string;
  readonly timeoutMs: number;

  constructor(lockPath: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for ledger lock ${lockPath}`);
    this.name = "LockTimeoutError";
    this.lockPath = lockPath;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Serializes access across processes using an atomically-created directory.
 *
 * A directory is used instead of an in-memory mutex because hooks and CLI
 * commands are intentionally short-lived independent processes.
 */
export async function withExclusiveFileLock<T>(
  targetPath: string,
  operation: () => Promise<T>,
  options: ExclusiveFileLockOptions = {},
): Promise<T> {
  const timeoutMs = positiveDuration(
    options.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    "timeoutMs",
    true,
  );
  const pollIntervalMs = positiveDuration(
    options.pollIntervalMs,
    DEFAULT_POLL_INTERVAL_MS,
    "pollIntervalMs",
  );
  const staleAfterMs = positiveDuration(
    options.staleAfterMs,
    DEFAULT_STALE_AFTER_MS,
    "staleAfterMs",
  );
  const lockPath = `${targetPath}.lock`;

  await mkdir(dirname(lockPath), { recursive: true });
  const owner = await acquireLock(lockPath, {
    timeoutMs,
    pollIntervalMs,
    staleAfterMs,
    signal: options.signal,
  });

  let completed = false;
  let result: T | undefined;
  let operationError: unknown;

  try {
    result = await operation();
    completed = true;
  } catch (error) {
    operationError = error;
  }

  try {
    await releaseLock(lockPath, owner);
  } catch (releaseError) {
    if (operationError === undefined) {
      throw releaseError;
    }
  }

  if (!completed) {
    throw operationError;
  }

  return result as T;
}

async function acquireLock(
  lockPath: string,
  options: ResolvedLockOptions,
): Promise<LockOwner> {
  const startedAt = Date.now();

  while (true) {
    throwIfAborted(options.signal);

    try {
      await mkdir(lockPath);
      if (await pathExists(reaperPath(lockPath))) {
        await rmdir(lockPath);
        throw alreadyExistsError(lockPath);
      }
      const owner: LockOwner = {
        token: randomBytes(16).toString("hex"),
        pid: process.pid,
        hostname: hostname(),
        createdAt: new Date().toISOString(),
      };

      try {
        await writeFile(
          ownerPath(lockPath),
          `${JSON.stringify(owner)}\n`,
          {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
          },
        );
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }

      return owner;
    } catch (error) {
      if (
        process.platform === "win32" &&
        hasErrorCode(error, "EPERM")
      ) {
        // NTFS can report EPERM while another process is removing the lock
        // directory. Unlike a stable ACL failure, this transition clears on
        // retry. Bound retries by the caller's normal lock timeout.
        const elapsed = Date.now() - startedAt;
        if (elapsed >= options.timeoutMs) {
          throw new LockTimeoutError(lockPath, options.timeoutMs);
        }
        await delay(
          Math.min(options.pollIntervalMs, options.timeoutMs - elapsed),
          options.signal,
        );
        continue;
      }
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
    }

    if (await reapAbandonedLock(lockPath, options.staleAfterMs)) {
      continue;
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed >= options.timeoutMs) {
      throw new LockTimeoutError(lockPath, options.timeoutMs);
    }

    await delay(
      Math.min(options.pollIntervalMs, options.timeoutMs - elapsed),
      options.signal,
    );
  }
}

async function releaseLock(lockPath: string, owner: LockOwner): Promise<void> {
  let currentOwner: LockOwner;
  try {
    currentOwner = JSON.parse(
      await readFile(ownerPath(lockPath), "utf8"),
    ) as LockOwner;
  } catch (error) {
    throw new Error(`Cannot verify ownership of ledger lock ${lockPath}`, {
      cause: error,
    });
  }

  if (currentOwner.token !== owner.token) {
    throw new Error(`Ledger lock ownership changed before release: ${lockPath}`);
  }

  await unlink(ownerPath(lockPath));
  await rmdir(lockPath);
}

async function reapAbandonedLock(
  lockPath: string,
  staleAfterMs: number,
): Promise<boolean> {
  const guardPath = reaperPath(lockPath);
  const guardOwner: LockOwner = {
    token: randomBytes(16).toString("hex"),
    pid: process.pid,
    hostname: hostname(),
    createdAt: new Date().toISOString(),
  };
  try {
    await mkdir(guardPath);
    try {
      await writeFile(
        ownerPath(guardPath),
        `${JSON.stringify(guardOwner)}\n`,
        {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        },
      );
    } catch (error) {
      await rm(guardPath, { recursive: true, force: true });
      throw error;
    }
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      return reapAbandonedReaperGuard(guardPath, staleAfterMs);
    }
    if (
      hasErrorCode(error, "ENOENT") ||
      (process.platform === "win32" && hasErrorCode(error, "EPERM"))
    ) {
      // The lock owner may remove lockPath after this contender observes
      // EEXIST but before it creates the nested reaper guard. POSIX normally
      // reports ENOENT; Windows can report EPERM for the same vanished-parent
      // race. Retry acquisition. If the parent still exists but is genuinely
      // inaccessible, the normal timeout remains fail-closed.
      return !(await pathExists(lockPath));
    }
    throw error;
  }

  try {
    return await reapAbandonedLockUnderGuard(lockPath, staleAfterMs);
  } finally {
    await rm(guardPath, { recursive: true, force: true });
  }
}

async function reapAbandonedReaperGuard(
  guardPath: string,
  staleAfterMs: number,
): Promise<boolean> {
  let ageMs: number;
  let owner: LockOwner | undefined;
  try {
    const guardStat = await stat(guardPath);
    ageMs = Date.now() - guardStat.mtimeMs;
    try {
      owner = JSON.parse(
        await readFile(ownerPath(guardPath), "utf8"),
      ) as LockOwner;
    } catch {
      // Guard publication is a mkdir followed by owner.json. A short grace
      // covers the live publication window without imposing the ledger's
      // much longer abandoned-owner threshold.
    }
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return true;
    throw error;
  }

  if (
    owner &&
    owner.hostname === hostname() &&
    Number.isSafeInteger(owner.pid) &&
    owner.pid > 0
  ) {
    if (isProcessAlive(owner.pid)) return false;
    await rm(guardPath, { recursive: true, force: true });
    return true;
  }
  if (owner && owner.hostname !== hostname()) return false;
  if (ageMs < (owner ? staleAfterMs : REAPER_PUBLICATION_GRACE_MS)) {
    return false;
  }

  await rm(guardPath, { recursive: true, force: true });
  return true;
}

async function reapAbandonedLockUnderGuard(
  lockPath: string,
  staleAfterMs: number,
): Promise<boolean> {
  let ageMs: number;
  let owner: LockOwner | undefined;

  try {
    const lockStat = await stat(lockPath);
    ageMs = Date.now() - lockStat.mtimeMs;
    try {
      owner = JSON.parse(
        await readFile(ownerPath(lockPath), "utf8"),
      ) as LockOwner;
      const createdAt = Date.parse(owner.createdAt);
      if (Number.isFinite(createdAt)) {
        ageMs = Math.min(ageMs, Date.now() - createdAt);
      }
    } catch {
      // A process may die between mkdir and writing owner.json. The directory
      // timestamp is the conservative fallback for that orphan state.
    }
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return true;
    }
    throw error;
  }

  const sameHostProcess =
    owner !== undefined &&
    owner.hostname === hostname() &&
    Number.isSafeInteger(owner.pid) &&
    owner.pid > 0;
  if (sameHostProcess && owner) {
    // A valid same-host dead PID is definitive and can be recovered
    // immediately. The stale grace remains for a live/reused PID and for the
    // mkdir-before-owner publication window.
    if (isProcessAlive(owner.pid)) return false;
  } else if (ageMs < staleAfterMs) {
    return false;
  }

  // Never reap a lock that may belong to another machine on shared storage.
  if (owner !== undefined && owner.hostname !== hostname()) {
    return false;
  }

  const quarantinePath = `${lockPath}.abandoned-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    await rename(lockPath, quarantinePath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "EEXIST")) {
      return true;
    }
    throw error;
  }

  await rm(quarantinePath, { recursive: true, force: true });
  return true;
}

function reaperPath(lockPath: string): string {
  return `${lockPath}.reaper`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

function alreadyExistsError(path: string): Error & { code: string } {
  return Object.assign(new Error(`Lock reaper is active for ${path}`), {
    code: "EEXIST",
  });
}

function ownerPath(lockPath: string): string {
  return `${lockPath}/owner.json`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasErrorCode(error, "ESRCH");
  }
}

function positiveDuration(
  value: number | undefined,
  fallback: number,
  field: string,
  allowZero = false,
): number {
  const duration = value ?? fallback;
  if (
    !Number.isFinite(duration) ||
    !Number.isInteger(duration) ||
    (allowZero ? duration < 0 : duration <= 0)
  ) {
    throw new RangeError(
      `${field} must be ${allowZero ? "a non-negative" : "a positive"} integer`,
    );
  }
  return duration;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);

    function done(): void {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }

    function aborted(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      reject(abortError());
    }

    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortError();
  }
}

function abortError(): Error {
  const error = new Error("Ledger lock acquisition was aborted");
  error.name = "AbortError";
  return error;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
