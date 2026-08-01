import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
  resolve,
  sep,
} from "node:path";
import { randomBytes } from "node:crypto";

import { DispatchError } from "../errors";

export interface DispatchPaths {
  readonly stateDir: string;
  readonly sessionsDir: string;
  readonly workDir: string;
  readonly workEventsPath: string;
  readonly indexPath: string;
  readonly machineIdPath: string;
  readonly configDir: string;
  readonly globalConfigPath: string;
  readonly cacheDir: string;
  readonly templatesDir: string;
  readonly defaultWorktreeRoot: string;
}

export type Environment = Readonly<Record<string, string | undefined>>;

function requiredHome(env: Environment): string {
  const candidate = env.HOME ?? env.USERPROFILE ?? homedir();
  if (!candidate) {
    throw new DispatchError(
      "paths.home_missing",
      "Cannot resolve a home directory; set HOME or USERPROFILE.",
    );
  }
  return resolve(candidate);
}

function platformBase(
  env: Environment,
  platform: NodeJS.Platform,
  kind: "state" | "config" | "cache" | "data",
): string {
  const home = requiredHome(env);
  const xdgVariable = {
    state: "XDG_STATE_HOME",
    config: "XDG_CONFIG_HOME",
    cache: "XDG_CACHE_HOME",
    data: "XDG_DATA_HOME",
  }[kind];
  const xdgValue = env[xdgVariable];
  if (xdgValue) return resolve(xdgValue);

  if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    if (kind === "config") {
      return resolve(env.APPDATA ?? join(home, "AppData", "Roaming"));
    }
    return resolve(local);
  }

  return {
    state: join(home, ".local", "state"),
    config: join(home, ".config"),
    cache: join(home, ".cache"),
    data: join(home, ".local", "share"),
  }[kind];
}

export function resolveDispatchPaths(
  env: Environment = process.env,
  platform: NodeJS.Platform = process.platform,
): DispatchPaths {
  const explicitHome = env.DISPATCH_HOME;
  const stateDir = explicitHome
    ? resolve(explicitHome)
    : join(platformBase(env, platform, "state"), "dispatch");
  const configDir = join(platformBase(env, platform, "config"), "dispatch");
  const cacheDir = join(platformBase(env, platform, "cache"), "dispatch");

  return {
    stateDir,
    sessionsDir: join(stateDir, "sessions"),
    workDir: join(stateDir, "intelligence", "work"),
    workEventsPath: join(stateDir, "intelligence", "work", "events.jsonl"),
    indexPath: join(stateDir, "index.sqlite"),
    machineIdPath: join(stateDir, "machine-id"),
    configDir,
    globalConfigPath: join(configDir, "config.toml"),
    cacheDir,
    templatesDir: join(cacheDir, "templates"),
    defaultWorktreeRoot: join(
      platformBase(env, platform, "data"),
      "dispatch",
      "worktrees",
    ),
  };
}

export function ensureStateDirectories(paths: DispatchPaths): void {
  ensurePrivateDirectory(paths.sessionsDir);
  ensurePrivateDirectory(paths.workDir);
}

function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;

  // Re-stabilize the complete visible chain on every call, including when no
  // directory is currently missing. A prior process can die after recursive
  // mkdir publishes a chain in the kernel cache but before its leaf-to-root
  // fsync pass completes. Treating that visible chain as durable on retry can
  // otherwise allow a later acknowledged ledger write to disappear with it.
  let cursor = resolve(directory);
  for (;;) {
    syncDirectory(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

function machineIdCandidate(): string {
  const host =
    hostname()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32) || "machine";
  return `${host}-${randomBytes(3).toString("hex")}`;
}

function validateMachineId(value: string): string {
  const trimmed = value.trim();
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/i.test(trimmed)) {
    throw new DispatchError(
      "paths.machine_id_invalid",
      `Invalid machine ID in state: ${JSON.stringify(trimmed)}`,
    );
  }
  return trimmed;
}

export function ensureMachineId(paths: DispatchPaths): string {
  ensureStateDirectories(paths);

  try {
    return validateMachineId(readFileSync(paths.machineIdPath, "utf8"));
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }

  const candidate = machineIdCandidate();
  const temporary = `${paths.machineIdPath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  let descriptor: number | undefined;
  let published = false;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${candidate}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, paths.machineIdPath);
    published = true;
    try {
      syncDirectory(paths.stateDir);
    } catch {
      // The final name is already visible. Do not report failure and cause a
      // caller to roll back later state while the machine ID remains.
    }
    return candidate;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      return validateMachineId(readFileSync(paths.machineIdPath, "utf8"));
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (
        !published &&
        (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "ENOENT"
        )
      ) {
        throw error;
      }
    }
  }
}

function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function expandPath(value: string, env: Environment = process.env): string {
  const home = requiredHome(env);
  if (value === "~") return home;
  if (value.startsWith(`~${sep}`) || value.startsWith("~/")) {
    return resolve(home, value.slice(2));
  }
  return isAbsolute(value) ? normalize(value) : resolve(value);
}

/**
 * Resolve a path to one case-preserving physical identity.
 *
 * Missing descendants are retained beneath the deepest existing ancestor so
 * planned worktree destinations canonicalize 8.3 names, junctions, and
 * symlinks before they are created.
 */
export function physicalPath(value: string): string {
  const absolute = resolve(value);
  let candidate = absolute;
  const missingSegments: string[] = [];
  let physical = absolute;

  for (;;) {
    try {
      physical = realpathSync.native(candidate);
      break;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        // Sandboxed or permission-restricted ancestors may not be
        // canonicalizable. Preserve lexical behavior for that candidate; an
        // accessible worktree or cwd was already resolved before ascent.
        physical = candidate;
        break;
      }
      const parent = dirname(candidate);
      if (parent === candidate) break;
      missingSegments.unshift(basename(candidate));
      candidate = parent;
    }
  }

  const normalized = normalize(join(physical, ...missingSegments));
  const trailingSeparators = process.platform === "win32"
    ? /[\\/]+$/
    : /\/+$/;
  const withoutTrailingSeparators = normalized === parse(normalized).root
    ? normalized
    : normalized.replace(trailingSeparators, "");
  return withoutTrailingSeparators;
}

export function pathKey(value: string): string {
  const physical = physicalPath(value);
  return process.platform === "win32" ? physical.toLowerCase() : physical;
}

export function sessionDirectory(paths: DispatchPaths, sid: string): string {
  return join(paths.sessionsDir, sid);
}
