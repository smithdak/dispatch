import type {
  AgentEventDraft,
  AgentHookTranslationResult,
  AgentHookTranslator,
  AgentHookValidationIssue,
} from "../../../ports/agent";

const PERMISSION_MODES = new Set([
  "default",
  "plan",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
]);

const EFFORT_LEVELS = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const KNOWN_CLAUDE_INPUT_FIELDS = new Set([
  "agent_id",
  "agent_transcript_path",
  "agent_type",
  "cwd",
  "duration_ms",
  "effort",
  "error",
  "hook_event_name",
  "is_interrupt",
  "last_assistant_message",
  "model",
  "permission_mode",
  "permission_suggestions",
  "prompt",
  "reason",
  "session_id",
  "session_title",
  "source",
  "stop_hook_active",
  "tool_input",
  "tool_name",
  "tool_response",
  "tool_use_id",
  "transcript_path",
]);

type JsonRecord = Record<string, unknown>;
type MutableJsonObject = Record<
  string,
  AgentEventDraft["data"][string]
>;

interface ValidatedCommon {
  raw: JsonRecord;
  cwd: string;
  eventName: string;
  providerSessionId: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requiredString(
  value: JsonRecord,
  key: string,
  issues: AgentHookValidationIssue[],
): string | undefined {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    issues.push({
      path: `$.${key}`,
      message: "expected a non-empty string",
    });
    return undefined;
  }

  return candidate;
}

function requiredBoolean(
  value: JsonRecord,
  key: string,
  issues: AgentHookValidationIssue[],
): boolean | undefined {
  const candidate = value[key];
  if (typeof candidate !== "boolean") {
    issues.push({
      path: `$.${key}`,
      message: "expected a boolean",
    });
    return undefined;
  }

  return candidate;
}

function requiredRecord(
  value: JsonRecord,
  key: string,
  issues: AgentHookValidationIssue[],
): JsonRecord | undefined {
  const candidate = value[key];
  if (!isRecord(candidate)) {
    issues.push({
      path: `$.${key}`,
      message: "expected an object",
    });
    return undefined;
  }

  return candidate;
}

function optionalString(
  value: JsonRecord,
  key: string,
  issues: AgentHookValidationIssue[],
): string | undefined {
  if (!hasOwn(value, key)) {
    return undefined;
  }

  return requiredString(value, key, issues);
}

function optionalBoolean(
  value: JsonRecord,
  key: string,
  issues: AgentHookValidationIssue[],
): boolean | undefined {
  if (!hasOwn(value, key)) {
    return undefined;
  }

  return requiredBoolean(value, key, issues);
}

function optionalFiniteNumber(
  value: JsonRecord,
  key: string,
  issues: AgentHookValidationIssue[],
): number | undefined {
  if (!hasOwn(value, key)) {
    return undefined;
  }

  const candidate = value[key];
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    issues.push({
      path: `$.${key}`,
      message: "expected a finite number",
    });
    return undefined;
  }

  return candidate;
}

function validateCommon(input: unknown): {
  common?: ValidatedCommon;
  issues: AgentHookValidationIssue[];
} {
  const issues: AgentHookValidationIssue[] = [];
  if (!isRecord(input)) {
    return {
      issues: [{ path: "$", message: "expected a JSON object" }],
    };
  }

  const providerSessionId = requiredString(input, "session_id", issues);
  requiredString(input, "transcript_path", issues);
  const cwd = requiredString(input, "cwd", issues);
  const eventName = requiredString(input, "hook_event_name", issues);

  const permissionMode = optionalString(input, "permission_mode", issues);
  if (
    permissionMode !== undefined &&
    !PERMISSION_MODES.has(permissionMode)
  ) {
    issues.push({
      path: "$.permission_mode",
      message: "expected a supported Claude Code permission mode",
    });
  }

  if (hasOwn(input, "effort")) {
    const effort = input.effort;
    if (!isRecord(effort)) {
      issues.push({ path: "$.effort", message: "expected an object" });
    } else {
      const level = effort.level;
      if (typeof level !== "string" || level.trim().length === 0) {
        issues.push({
          path: "$.effort.level",
          message: "expected a non-empty string",
        });
      } else if (!EFFORT_LEVELS.has(level)) {
        issues.push({
          path: "$.effort.level",
          message: "expected a supported Claude Code effort level",
        });
      }
    }
  }

  optionalString(input, "agent_id", issues);
  optionalString(input, "agent_type", issues);

  if (
    issues.length > 0 ||
    providerSessionId === undefined ||
    cwd === undefined ||
    eventName === undefined
  ) {
    return { issues };
  }

  return {
    common: {
      raw: input,
      cwd,
      eventName,
      providerSessionId,
    },
    issues,
  };
}

function copyString(
  source: JsonRecord,
  target: JsonRecord,
  key: string,
  maxLength = 512,
): void {
  const value = source[key];
  if (typeof value === "string" && value.length > 0) {
    target[key] =
      value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
  }
}

function copyBoolean(
  source: JsonRecord,
  target: JsonRecord,
  key: string,
): void {
  if (typeof source[key] === "boolean") {
    target[key] = source[key];
  }
}

function copyFiniteNumber(
  source: JsonRecord,
  target: JsonRecord,
  key: string,
): void {
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    target[key] = value;
  }
}

/**
 * Retain useful provider correlation metadata without retaining conversation
 * text, tool arguments, tool responses, or transcript contents.
 */
function claudeExtension(
  input: JsonRecord,
  includeFutureScalars = false,
): NonNullable<AgentEventDraft["ext"]> {
  const claude: MutableJsonObject = {};

  for (const key of [
    "hook_event_name",
    "session_id",
    "permission_mode",
    "source",
    "model",
    "tool_use_id",
    "agent_id",
    "agent_type",
    "reason",
  ]) {
    copyString(input, claude, key);
  }

  for (const key of ["stop_hook_active", "is_interrupt"]) {
    copyBoolean(input, claude, key);
  }

  copyFiniteNumber(input, claude, "duration_ms");

  if (isRecord(input.effort) && typeof input.effort.level === "string") {
    claude.effort_level = input.effort.level;
  }

  if (typeof input.prompt === "string") {
    claude.prompt_chars = input.prompt.length;
  }

  if (typeof input.last_assistant_message === "string") {
    claude.last_assistant_message_chars = input.last_assistant_message.length;
  }

  if (isRecord(input.tool_input)) {
    claude.tool_input_keys = Object.keys(input.tool_input).sort();
  }

  if (hasOwn(input, "tool_response")) {
    claude.tool_response_type = Array.isArray(input.tool_response)
      ? "array"
      : input.tool_response === null
        ? "null"
        : typeof input.tool_response;
  }

  if (Array.isArray(input.permission_suggestions)) {
    claude.permission_suggestion_count = input.permission_suggestions.length;
  }

  if (includeFutureScalars) {
    // Future provider payloads are untrusted retention surfaces. Record shape
    // metadata only; never persist an unknown value, even when it is scalar.
    // Names are limited to ordinary field identifiers so a malicious key
    // cannot smuggle a body through metadata.
    const unknownFields = Object.entries(input)
      .filter(([key]) => !KNOWN_CLAUDE_INPUT_FIELDS.has(key))
      .map(([key, value]) => ({
        ...(key.length <= 64 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
          ? { name: key }
          : {}),
        type: Array.isArray(value)
          ? "array"
          : value === null
            ? "null"
            : typeof value,
      }))
      .sort((left, right) =>
        (left.name ?? "").localeCompare(right.name ?? ""),
      );
    if (unknownFields.length > 0) {
      claude.unknown_fields = unknownFields;
    }
  }

  return { claude };
}

function safeToolPath(toolInput: JsonRecord | undefined): string | undefined {
  if (toolInput === undefined) {
    return undefined;
  }

  for (const key of ["file_path", "notebook_path", "path"]) {
    const value = toolInput[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

function draft(
  kind: AgentEventDraft["kind"],
  data: AgentEventDraft["data"],
  input: JsonRecord,
  includeFutureScalars = false,
): AgentEventDraft {
  return {
    src: "hook",
    kind,
    data,
    ext: claudeExtension(input, includeFutureScalars),
  };
}

function translateKnown(
  common: ValidatedCommon,
  issues: AgentHookValidationIssue[],
): AgentEventDraft[] {
  const input = common.raw;

  switch (common.eventName) {
    case "SessionStart": {
      requiredString(input, "source", issues);
      optionalString(input, "model", issues);
      optionalString(input, "session_title", issues);
      return [draft("agent.started", { scope: "main" }, input)];
    }

    case "SessionEnd": {
      requiredString(input, "reason", issues);
      return [draft("agent.stopped", { scope: "main" }, input)];
    }

    case "UserPromptSubmit": {
      const prompt = requiredString(input, "prompt", issues);
      return [
        draft(
          "turn.started",
          prompt === undefined ? {} : { inputChars: prompt.length },
          input,
        ),
      ];
    }

    case "Stop": {
      requiredBoolean(input, "stop_hook_active", issues);
      const message = requiredString(input, "last_assistant_message", issues);
      return [
        draft(
          "turn.completed",
          message === undefined ? {} : { outputChars: message.length },
          input,
        ),
      ];
    }

    case "PreToolUse": {
      const name = requiredString(input, "tool_name", issues);
      const toolInput = requiredRecord(input, "tool_input", issues);
      requiredString(input, "tool_use_id", issues);
      const path = safeToolPath(toolInput);
      return [
        draft(
          "tool.called",
          {
            ...(name === undefined ? {} : { name }),
            ...(path === undefined ? {} : { path }),
          },
          input,
        ),
      ];
    }

    case "PostToolUse": {
      const name = requiredString(input, "tool_name", issues);
      const toolInput = requiredRecord(input, "tool_input", issues);
      requiredString(input, "tool_use_id", issues);
      if (!hasOwn(input, "tool_response")) {
        issues.push({
          path: "$.tool_response",
          message: "expected the field to be present",
        });
      }
      const durationMs = optionalFiniteNumber(input, "duration_ms", issues);
      const path = safeToolPath(toolInput);
      return [
        draft(
          "tool.result",
          {
            ...(name === undefined ? {} : { name }),
            ok: true,
            ...(path === undefined ? {} : { path }),
            ...(durationMs === undefined ? {} : { durationMs }),
          },
          input,
        ),
      ];
    }

    case "PostToolUseFailure": {
      const name = requiredString(input, "tool_name", issues);
      const toolInput = requiredRecord(input, "tool_input", issues);
      requiredString(input, "tool_use_id", issues);
      requiredString(input, "error", issues);
      const interrupted = optionalBoolean(input, "is_interrupt", issues);
      const durationMs = optionalFiniteNumber(input, "duration_ms", issues);
      const path = safeToolPath(toolInput);
      return [
        draft(
          "tool.result",
          {
            ...(name === undefined ? {} : { name }),
            ok: false,
            ...(path === undefined ? {} : { path }),
            ...(interrupted === undefined ? {} : { interrupted }),
            ...(durationMs === undefined ? {} : { durationMs }),
          },
          input,
        ),
      ];
    }

    case "PermissionRequest": {
      const name = requiredString(input, "tool_name", issues);
      requiredRecord(input, "tool_input", issues);
      if (
        hasOwn(input, "permission_suggestions") &&
        !Array.isArray(input.permission_suggestions)
      ) {
        issues.push({
          path: "$.permission_suggestions",
          message: "expected an array",
        });
      }
      return [
        draft(
          "permission.requested",
          name === undefined ? {} : { name },
          input,
        ),
      ];
    }

    case "PermissionDenied": {
      const name = requiredString(input, "tool_name", issues);
      requiredRecord(input, "tool_input", issues);
      requiredString(input, "tool_use_id", issues);
      requiredString(input, "reason", issues);
      return [
        draft(
          "permission.decided",
          {
            ...(name === undefined ? {} : { name }),
            decision: "deny",
          },
          input,
        ),
      ];
    }

    case "SubagentStart": {
      requiredString(input, "agent_id", issues);
      const role = requiredString(input, "agent_type", issues);
      return [
        draft(
          "agent.started",
          {
            scope: "subagent",
            ...(role === undefined ? {} : { role }),
          },
          input,
        ),
      ];
    }

    case "SubagentStop": {
      requiredBoolean(input, "stop_hook_active", issues);
      requiredString(input, "agent_id", issues);
      const role = requiredString(input, "agent_type", issues);
      requiredString(input, "agent_transcript_path", issues);
      requiredString(input, "last_assistant_message", issues);
      return [
        draft(
          "agent.stopped",
          {
            scope: "subagent",
            ...(role === undefined ? {} : { role }),
          },
          input,
        ),
      ];
    }

    default:
      return [
        draft(
          "agent.state",
          { state: "provider-event-observed" },
          input,
          true,
        ),
      ];
  }
}

export function translateClaudeHook(
  input: unknown,
): AgentHookTranslationResult {
  const validated = validateCommon(input);
  if (validated.common === undefined) {
    return { ok: false, issues: validated.issues };
  }

  const drafts = translateKnown(validated.common, validated.issues);
  if (validated.issues.length > 0) {
    return { ok: false, issues: validated.issues };
  }

  return {
    ok: true,
    value: {
      cwd: validated.common.cwd,
      providerSessionId: validated.common.providerSessionId,
      drafts,
    },
  };
}

export const claudeHookTranslator: AgentHookTranslator = {
  translate: translateClaudeHook,
};
