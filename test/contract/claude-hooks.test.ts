import { describe, expect, test } from "bun:test";

import {
  CLAUDE_HOOK_EVENTS,
  createClaudeHookEntries,
  mergeClaudeHookSettings,
  translateClaudeHook,
} from "../../src/adapters/hooks/claude";

const FIXTURE_ROOT = new URL("../fixtures/claude/", import.meta.url);

async function fixture(name: string): Promise<unknown> {
  return Bun.file(new URL(name, FIXTURE_ROOT)).json();
}

const MAPPINGS = [
  ["session-start.json", "agent.started"],
  ["session-end.json", "agent.stopped"],
  ["user-prompt-submit.json", "turn.started"],
  ["stop.json", "turn.completed"],
  ["pre-tool-use.json", "tool.called"],
  ["post-tool-use.json", "tool.result"],
  ["post-tool-use-failure.json", "tool.result"],
  ["permission-request.json", "permission.requested"],
  ["permission-denied.json", "permission.decided"],
  ["subagent-start.json", "agent.started"],
  ["subagent-stop.json", "agent.stopped"],
] as const;

describe("Claude Code hook translation contract", () => {
  for (const [fixtureName, expectedKind] of MAPPINGS) {
    test(`${fixtureName} maps to ${expectedKind}`, async () => {
      const result = translateClaudeHook(await fixture(fixtureName));

      if (!result.ok) {
        throw new Error(`unexpected validation failure: ${JSON.stringify(result.issues)}`);
      }

      expect(result.value.cwd).toBe("/workspace/repo");
      expect(result.value.providerSessionId).toBe("claude-session-001");
      expect(result.value.drafts).toHaveLength(1);

      const event = result.value.drafts[0];
      expect(event?.src).toBe("hook");
      expect(event?.kind).toBe(expectedKind);
      expect(Object.keys(event ?? {}).sort()).toEqual([
        "data",
        "ext",
        "kind",
        "src",
      ]);
      expect(Object.keys(event?.ext ?? {})).toEqual(["claude"]);
      const claude = event?.ext?.claude;
      expect(typeof claude).toBe("object");
      const claudeRecord = claude as
        | Readonly<Record<string, unknown>>
        | undefined;
      expect(
        claudeRecord?.hook_event_name,
      ).toBeDefined();
      expect(
        claudeRecord?.session_id,
      ).toBe("claude-session-001");

      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain("PRIVATE_");
      expect(serialized).not.toContain("transcript_path");
      expect(serialized).not.toContain("tool_input\":");
      expect(serialized).not.toContain("tool_response\":");
      expect(serialized).not.toContain("last_assistant_message\":");
      expect(serialized).not.toContain("\"prompt\":");
    });
  }

  test("maps only compact canonical tool data", async () => {
    const result = translateClaudeHook(await fixture("pre-tool-use.json"));
    if (!result.ok) {
      throw new Error(`unexpected validation failure: ${JSON.stringify(result.issues)}`);
    }

    expect(result.value.drafts[0]?.data).toEqual({
      name: "Write",
      path: "/workspace/repo/src/index.ts",
    });
    expect(result.value.drafts[0]?.ext?.claude).toMatchObject({
      hook_event_name: "PreToolUse",
      session_id: "claude-session-001",
      tool_use_id: "toolu_001",
      effort_level: "high",
      tool_input_keys: ["content", "file_path"],
    });
  });

  test("records failure state without retaining the command or error body", async () => {
    const result = translateClaudeHook(
      await fixture("post-tool-use-failure.json"),
    );
    if (!result.ok) {
      throw new Error(`unexpected validation failure: ${JSON.stringify(result.issues)}`);
    }

    expect(result.value.drafts[0]?.data).toEqual({
      name: "Bash",
      ok: false,
      interrupted: false,
      durationMs: 4187,
    });
    expect(result.value.drafts[0]?.ext?.claude).not.toHaveProperty("error");
  });

  test("degrades a future valid hook event to agent.state", async () => {
    const result = translateClaudeHook(await fixture("future-event.json"));
    if (!result.ok) {
      throw new Error(`unexpected validation failure: ${JSON.stringify(result.issues)}`);
    }

    expect(result.value.drafts).toEqual([
      {
        src: "hook",
        kind: "agent.state",
        data: { state: "provider-event-observed" },
        ext: {
          claude: {
            hook_event_name: "FutureLifecycleEvent",
            session_id: "claude-session-001",
            permission_mode: "default",
            unknown_fields: [
              { name: "command", type: "string" },
              { name: "future_counter", type: "number" },
              { name: "future_flag", type: "boolean" },
              { name: "future_message", type: "string" },
              { name: "future_state", type: "string" },
              { name: "query", type: "string" },
              { name: "stdout", type: "string" },
            ],
          },
        },
      },
    ]);
    expect(JSON.stringify(result.value.drafts)).not.toContain(
      "PRIVATE_FUTURE_MESSAGE",
    );
    expect(JSON.stringify(result.value.drafts)).not.toContain(
      "PRIVATE_COMMAND",
    );
    expect(JSON.stringify(result.value.drafts)).not.toContain(
      "PRIVATE_QUERY",
    );
    expect(JSON.stringify(result.value.drafts)).not.toContain(
      "PRIVATE_STDOUT",
    );
  });

  test("rejects malformed common fields without producing drafts", async () => {
    const result = translateClaudeHook(await fixture("malformed.json"));

    expect(result.ok).toBeFalse();
    if (result.ok) {
      throw new Error("malformed input unexpectedly translated");
    }

    expect(result.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "$.session_id",
        "$.transcript_path",
        "$.cwd",
        "$.permission_mode",
      ]),
    );
  });

  test("rejects malformed event-specific fields", async () => {
    const base = await fixture("pre-tool-use.json");
    if (typeof base !== "object" || base === null || Array.isArray(base)) {
      throw new Error("fixture is not an object");
    }

    const result = translateClaudeHook({
      ...base,
      tool_input: "not-an-object",
      tool_use_id: 12,
    });

    expect(result.ok).toBeFalse();
    if (result.ok) {
      throw new Error("malformed input unexpectedly translated");
    }
    expect(result.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(["$.tool_input", "$.tool_use_id"]),
    );
  });

  test("rejects non-object input", () => {
    expect(translateClaudeHook(null)).toEqual({
      ok: false,
      issues: [{ path: "$", message: "expected a JSON object" }],
    });
  });
});

describe("Claude Code hook settings", () => {
  test("produces a command hook for every translated event", () => {
    const entries = createClaudeHookEntries();

    expect(Object.keys(entries)).toEqual([...CLAUDE_HOOK_EVENTS]);
    for (const eventName of CLAUDE_HOOK_EVENTS) {
      expect(entries[eventName]).toEqual([
        {
          hooks: [
            {
              type: "command",
              command: "dsp",
              args: ["hook", "claude"],
            },
          ],
        },
      ]);
    }
  });

  test("merges without mutating or removing existing settings", () => {
    const settings = {
      model: "opus",
      hooks: {
        Notification: [
          {
            matcher: "idle_prompt",
            hooks: [{ type: "command", command: "notify" }],
          },
        ],
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "audit-bash" }],
          },
        ],
      },
    };
    const before = structuredClone(settings);

    const merged = mergeClaudeHookSettings(settings);

    expect(settings).toEqual(before);
    expect(merged.model).toBe("opus");
    expect(
      (merged.hooks as Record<string, unknown>).Notification,
    ).toEqual(settings.hooks.Notification);
    expect(
      (merged.hooks as Record<string, unknown>).PreToolUse,
    ).toHaveLength(2);
  });

  test("is idempotent for the same unrestricted command hook", () => {
    const once = mergeClaudeHookSettings({});
    const twice = mergeClaudeHookSettings(once);

    expect(twice).toEqual(once);
    for (const eventName of CLAUDE_HOOK_EVENTS) {
      expect(
        (twice.hooks as Record<string, unknown[]>)[eventName],
      ).toHaveLength(1);
    }
  });

  test("does not treat a restricted matcher as full event coverage", () => {
    const merged = mergeClaudeHookSettings({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: "dsp",
                args: ["hook", "claude"],
              },
            ],
          },
        ],
      },
    });

    expect(
      (merged.hooks as Record<string, unknown[]>).PreToolUse,
    ).toHaveLength(2);
  });

  test("rejects malformed settings rather than overwriting them", () => {
    expect(() => mergeClaudeHookSettings(null)).toThrow(TypeError);
    expect(() => mergeClaudeHookSettings({ hooks: [] })).toThrow(TypeError);
    expect(() =>
      mergeClaudeHookSettings({ hooks: { Stop: {} } }),
    ).toThrow(TypeError);
  });
});
