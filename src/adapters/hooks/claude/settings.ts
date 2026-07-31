export const CLAUDE_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "Stop",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
  "SubagentStart",
  "SubagentStop",
] as const;

export type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number];

export interface ClaudeHookInvocation {
  command: string;
  args: string[];
}

export interface ClaudeCommandHook {
  type: "command";
  command: string;
  args: string[];
}

export interface ClaudeHookGroup {
  hooks: ClaudeCommandHook[];
}

export type ClaudeHookEntries = Record<
  ClaudeHookEvent,
  ClaudeHookGroup[]
>;

export const DEFAULT_CLAUDE_HOOK_INVOCATION: ClaudeHookInvocation = {
  command: "dsp",
  args: ["hook", "claude"],
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function validateInvocation(
  invocation: ClaudeHookInvocation,
): ClaudeHookInvocation {
  if (
    typeof invocation.command !== "string" ||
    invocation.command.trim().length === 0
  ) {
    throw new TypeError("Claude hook command must be a non-empty string");
  }

  if (
    !Array.isArray(invocation.args) ||
    invocation.args.some((argument) => typeof argument !== "string")
  ) {
    throw new TypeError("Claude hook args must be an array of strings");
  }

  return {
    command: invocation.command,
    args: [...invocation.args],
  };
}

function commandHook(
  invocation: ClaudeHookInvocation,
): ClaudeCommandHook {
  return {
    type: "command",
    command: invocation.command,
    args: [...invocation.args],
  };
}

function hasDispatchHookArguments(value: unknown): value is JsonRecord {
  if (
    !isRecord(value) ||
    value.type !== "command" ||
    !Array.isArray(value.args) ||
    value.args.length !== 2
  ) {
    return false;
  }

  return value.args[0] === "hook" && value.args[1] === "claude";
}

function isManagedDispatchCommandHook(
  value: unknown,
  invocation: ClaudeHookInvocation,
): boolean {
  if (!hasDispatchHookArguments(value) || typeof value.command !== "string") {
    return false;
  }
  if (value.command === invocation.command) return true;
  const executableName = value.command.split(/[\\/]/).at(-1)?.toLowerCase();
  return executableName === "dsp" || executableName === "dsp.exe";
}

function migrateUnrestrictedDispatchGroup(
  value: unknown,
  invocation: ClaudeHookInvocation,
  retainHandler: boolean,
): { readonly group: unknown | null; readonly foundManaged: boolean } {
  if (
    !isRecord(value) ||
    hasMeaningfulMatcher(value.matcher) ||
    !Array.isArray(value.hooks)
  ) {
    return { group: value, foundManaged: false };
  }

  let foundManaged = false;
  let retained = false;
  const hooks: unknown[] = [];
  for (const hook of value.hooks) {
    if (!isManagedDispatchCommandHook(hook, invocation)) {
      hooks.push(hook);
      continue;
    }
    foundManaged = true;
    if (retainHandler && !retained) {
      hooks.push(commandHook(invocation));
      retained = true;
    }
  }

  if (!foundManaged) return { group: value, foundManaged: false };
  return {
    group: hooks.length === 0 ? null : { ...value, hooks },
    foundManaged: true,
  };
}

function hasMeaningfulMatcher(value: unknown): boolean {
  return typeof value === "string" && value !== "" && value !== "*";
}

/**
 * Produce the complete set of settings entries consumed by `dsp hook claude`.
 */
export function createClaudeHookEntries(
  requestedInvocation: ClaudeHookInvocation =
    DEFAULT_CLAUDE_HOOK_INVOCATION,
): ClaudeHookEntries {
  const invocation = validateInvocation(requestedInvocation);
  return Object.fromEntries(
    CLAUDE_HOOK_EVENTS.map((eventName) => [
      eventName,
      [{ hooks: [commandHook(invocation)] }],
    ]),
  ) as ClaudeHookEntries;
}

/**
 * Merge Dispatch command hooks into an existing Claude settings object.
 *
 * The input is never mutated. Non-Dispatch settings and hook groups are
 * preserved. Existing unrestricted Dispatch handlers are migrated to the
 * requested invocation and collapsed to one handler, making installation both
 * upgrade-safe and idempotent.
 */
export function mergeClaudeHookSettings(
  settings: unknown,
  requestedInvocation: ClaudeHookInvocation =
    DEFAULT_CLAUDE_HOOK_INVOCATION,
): Record<string, unknown> {
  if (!isRecord(settings)) {
    throw new TypeError("Claude settings must be a JSON object");
  }

  const invocation = validateInvocation(requestedInvocation);
  const existingHooks = settings.hooks;
  if (existingHooks !== undefined && !isRecord(existingHooks)) {
    throw new TypeError("Claude settings hooks must be a JSON object");
  }

  const mergedHooks: JsonRecord = {
    ...(existingHooks ?? {}),
  };

  for (const eventName of CLAUDE_HOOK_EVENTS) {
    const current = mergedHooks[eventName];
    if (current !== undefined && !Array.isArray(current)) {
      throw new TypeError(`Claude hook ${eventName} must be an array`);
    }

    let retainedDispatchHandler = false;
    const groups: unknown[] = [];
    for (const group of current === undefined ? [] : current) {
      const migrated = migrateUnrestrictedDispatchGroup(
        group,
        invocation,
        !retainedDispatchHandler,
      );
      if (migrated.foundManaged) retainedDispatchHandler = true;
      if (migrated.group !== null) groups.push(migrated.group);
    }
    if (!retainedDispatchHandler) {
      groups.push({ hooks: [commandHook(invocation)] });
    }
    mergedHooks[eventName] = groups;
  }

  return {
    ...settings,
    hooks: mergedHooks,
  };
}
