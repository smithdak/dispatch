import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

import { mergeHookSettings } from "../adapters/registry";
import { DispatchError } from "../core/errors";
import type { Environment } from "../core/paths";

declare const __DISPATCH_STANDALONE__: boolean;

export type HookInstallScope = "user" | "project";

export interface HookInstallResult {
  readonly path: string;
  readonly changed: boolean;
  readonly scope: HookInstallScope;
  readonly inheritedByFutureWorktrees: boolean;
}

export interface InstallClaudeHooksOptions {
  /**
   * When present, install only for this project. Omitting it installs at
   * Claude user scope so future Dispatch worktrees inherit the hook.
   */
  readonly projectPath?: string;
  readonly command?: string;
  readonly env?: Environment;
  /** Injectable only for deterministic source-versus-standalone tests. */
  readonly runtime?: {
    readonly executablePath: string;
    readonly standalone: boolean;
  };
}

export function defaultClaudeHookCommand(runtime: {
  readonly executablePath: string;
  readonly standalone: boolean;
} = {
  executablePath: process.execPath,
  standalone:
    typeof __DISPATCH_STANDALONE__ !== "undefined" &&
    __DISPATCH_STANDALONE__ === true,
}): string {
  // The build injects the standalone marker. Bun.main cannot identify this
  // reliably because a compiled CLI retains the embedded `main.ts` path.
  if (runtime.standalone) return resolve(runtime.executablePath);
  throw new DispatchError(
    "hooks.command_required",
    "Source-mode hook installation requires --command with an absolute compiled dsp executable.",
  );
}

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new DispatchError(
      "hooks.settings_parse_failed",
      `Cannot parse Claude settings at ${path}.`,
      { path },
      { cause: error },
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DispatchError(
      "hooks.settings_invalid",
      `Claude settings must be a JSON object: ${path}.`,
      { path },
    );
  }
  return parsed as Record<string, unknown>;
}

function writeAtomically(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function userHome(env: Environment): string {
  const candidate = env.HOME ?? env.USERPROFILE;
  if (candidate === undefined || candidate.trim().length === 0) {
    throw new DispatchError(
      "hooks.home_missing",
      "Cannot resolve Claude user settings; set HOME or USERPROFILE.",
    );
  }
  return resolve(candidate);
}

export function installClaudeHooks(
  options: InstallClaudeHooksOptions = {},
): HookInstallResult {
  const scope: HookInstallScope =
    options.projectPath === undefined ? "user" : "project";
  if (
    options.projectPath !== undefined &&
    options.projectPath.trim().length === 0
  ) {
    throw new DispatchError(
      "hooks.project_invalid",
      "Claude project hook installation requires a non-empty project path.",
    );
  }
  const path =
    scope === "user"
      ? join(userHome(options.env ?? process.env), ".claude", "settings.json")
      : join(
          resolve(options.projectPath!),
          ".claude",
          "settings.local.json",
        );
  const existing = readSettings(path);
  const command =
    options.command ?? defaultClaudeHookCommand(options.runtime);
  const merged = mergeHookSettings("claude", existing, {
    command,
    args: ["hook", "claude"],
  });
  const existingSerialized = JSON.stringify(existing);
  const mergedSerialized = JSON.stringify(merged);
  const result = {
    path,
    scope,
    inheritedByFutureWorktrees: scope === "user",
  } as const;
  if (existingSerialized === mergedSerialized) {
    return { ...result, changed: false };
  }
  writeAtomically(path, merged);
  return { ...result, changed: true };
}
