import {
  mergeClaudeHookSettings,
  translateClaudeHook,
  type ClaudeHookInvocation,
} from "./hooks/claude";
import type { AgentHookTranslationResult } from "../ports/agent";

export type HookProvider = "claude";

export function translateHook(
  provider: HookProvider,
  input: unknown,
): AgentHookTranslationResult {
  switch (provider) {
    case "claude":
      return translateClaudeHook(input);
  }
}

export function mergeHookSettings(
  provider: HookProvider,
  settings: unknown,
  invocation?: ClaudeHookInvocation,
): Record<string, unknown> {
  switch (provider) {
    case "claude":
      return invocation
        ? mergeClaudeHookSettings(settings, invocation)
        : mergeClaudeHookSettings(settings);
  }
}
