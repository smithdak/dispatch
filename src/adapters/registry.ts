import {
  mergeClaudeHookSettings,
  translateClaudeHook,
  type ClaudeHookInvocation,
} from "./hooks/claude";
import type { AgentHookTranslationResult } from "../ports/agent";
import type { Environment } from "../core/paths";
import type { MuxPort, MuxPromptPort } from "../ports/mux";

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

/**
 * Resolve the native Windows mux lazily so provider hook ingestion never
 * imports the orchestration adapter or its process-control code.
 */
export async function loadMuxPort(
  env: Environment = process.env,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): Promise<MuxPort & MuxPromptPort> {
  if (platform !== "win32" || architecture !== "x64") {
    const { MuxError } = await import("../ports/mux");
    throw new MuxError(
      "unavailable",
      `Native orchestration is qualified only on Windows x64; received ${platform}/${architecture}.`,
      { platform, architecture },
    );
  }

  const { createHerdrMux } = await import("./mux-windows/herdr");
  const executable = env.DISPATCH_HERDR_BIN;
  const session = env.DISPATCH_HERDR_SESSION ?? "default";
  return createHerdrMux(executable ? { executable, session } : { session });
}
