import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { DispatchError } from "../errors";
import {
  expandPath,
  type DispatchPaths,
  type Environment,
} from "../paths";

export interface DispatchConfig {
  readonly worktrees: {
    readonly root: string;
    readonly branchPrefix: string;
  };
  readonly ledger: {
    readonly fsync: boolean;
    readonly lockTimeoutMs: number;
  };
}

type PartialConfig = {
  worktrees?: {
    root?: string;
    branch_prefix?: string;
  };
  ledger?: {
    fsync?: boolean;
    lock_timeout_ms?: number;
  };
};

const TOP_LEVEL_KEYS = new Set(["worktrees", "ledger"]);
const SECTION_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  worktrees: new Set(["root", "branch_prefix"]),
  ledger: new Set(["fsync", "lock_timeout_ms"]),
};

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DispatchError(
      "config.invalid",
      `${context} must be a TOML table.`,
    );
  }
  return value as Record<string, unknown>;
}

function assertKnownKeys(parsed: Record<string, unknown>, source: string): void {
  for (const [key, value] of Object.entries(parsed)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      throw new DispatchError(
        "config.unknown_key",
        `Unknown config key ${JSON.stringify(key)} in ${source}.`,
      );
    }
    const section = record(value, `${source} [${key}]`);
    for (const sectionKey of Object.keys(section)) {
      if (!SECTION_KEYS[key]?.has(sectionKey)) {
        throw new DispatchError(
          "config.unknown_key",
          `Unknown config key ${JSON.stringify(`${key}.${sectionKey}`)} in ${source}.`,
        );
      }
    }
  }
}

function parseConfig(path: string): PartialConfig {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new DispatchError(
      "config.parse_failed",
      `Cannot parse config ${path}.`,
      { path },
      { cause: error },
    );
  }
  const parsedRecord = record(parsed, path);
  assertKnownKeys(parsedRecord, path);
  return parsedRecord as PartialConfig;
}

function mergeConfig(
  base: PartialConfig,
  override: PartialConfig,
): PartialConfig {
  const result: PartialConfig = {};
  if (base.worktrees || override.worktrees) {
    result.worktrees = { ...base.worktrees, ...override.worktrees };
  }
  if (base.ledger || override.ledger) {
    result.ledger = { ...base.ledger, ...override.ledger };
  }
  return result;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  key: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new DispatchError(
      "config.invalid",
      `${key} must be a positive integer.`,
    );
  }
  return result;
}

export function loadConfig(
  paths: DispatchPaths,
  repository?: string,
  env: Environment = process.env,
): DispatchConfig {
  let merged: PartialConfig = {};
  if (existsSync(paths.globalConfigPath)) {
    merged = parseConfig(paths.globalConfigPath);
  }

  if (repository) {
    const projectPath = join(resolve(repository), ".dispatch.toml");
    if (existsSync(projectPath)) {
      merged = mergeConfig(merged, parseConfig(projectPath));
    }
  }

  const configuredRoot =
    env.DISPATCH_WORKTREE_ROOT ??
    merged.worktrees?.root ??
    paths.defaultWorktreeRoot;
  const branchPrefix =
    env.DISPATCH_BRANCH_PREFIX ??
    merged.worktrees?.branch_prefix ??
    "dispatch/";
  if (!/^[A-Za-z0-9._/-]*$/.test(branchPrefix) || branchPrefix.startsWith("-")) {
    throw new DispatchError(
      "config.invalid",
      "worktrees.branch_prefix is not a safe Git ref prefix.",
    );
  }

  const fsync = merged.ledger?.fsync ?? true;
  if (typeof fsync !== "boolean") {
    throw new DispatchError("config.invalid", "ledger.fsync must be boolean.");
  }

  return {
    worktrees: {
      root: expandPath(configuredRoot, env),
      branchPrefix,
    },
    ledger: {
      fsync,
      lockTimeoutMs: positiveInteger(
        merged.ledger?.lock_timeout_ms,
        2_000,
        "ledger.lock_timeout_ms",
      ),
    },
  };
}
