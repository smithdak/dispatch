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

function isSameInvocation(
  value: unknown,
  invocation: ClaudeHookInvocation,
): boolean {
  if (
    !isRecord(value) ||
    value.type !== "command" ||
    value.command !== invocation.command ||
    !Array.isArray(value.args) ||
    value.args.length !== invocation.args.length
  ) {
    return false;
  }

  return value.args.every(
    (argument, index) => argument === invocation.args[index],
  );
}

function isUnmatchedDispatchGroup(
  value: unknown,
  invocation: ClaudeHookInvocation,
): boolean {
  if (!isRecord(value) || hasMeaningfulMatcher(value.matcher)) {
    return false;
  }

  return (
    Array.isArray(value.hooks) &&
    value.hooks.some((hook) => isSameInvocation(hook, invocation))
  );
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
 * The input is never mutated. Existing settings and hook groups are preserved,
 * and an existing unrestricted Dispatch handler is reused so the operation is
 * idempotent.
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

    const groups = current === undefined ? [] : [...current];
    if (
      !groups.some((group) =>
        isUnmatchedDispatchGroup(group, invocation),
      )
    ) {
      groups.push({ hooks: [commandHook(invocation)] });
    }
    mergedHooks[eventName] = groups;
  }

  return {
    ...settings,
    hooks: mergedHooks,
  };
}
