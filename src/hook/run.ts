import { loadConfig } from "../core/config";
import { SessionIndex } from "../core/index";
import {
  ensureStateDirectories,
  resolveDispatchPaths,
} from "../core/paths";
import { translateHook, type HookProvider } from "../adapters/registry";
import {
  appendSessionEvent,
  resolveSessionMetaByPath,
} from "../application/ledger-service";

export interface HookRunResult {
  readonly captured: boolean;
  readonly events: number;
  readonly projectionWarnings: number;
}

function validationMessage(
  issues: ReadonlyArray<{ readonly path: string; readonly message: string }>,
): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
}

export async function ingestHookPayload(
  provider: HookProvider,
  input: unknown,
): Promise<HookRunResult> {
  const translation = translateHook(provider, input);
  if (!translation.ok) {
    throw new Error(
      `Invalid ${provider} hook payload: ${validationMessage(translation.issues)}`,
    );
  }

  const paths = resolveDispatchPaths();
  ensureStateDirectories(paths);
  const index = new SessionIndex(paths.indexPath);
  try {
    const meta = await resolveSessionMetaByPath(
      paths,
      translation.value.cwd,
      index,
    );
    // Hooks may be installed user-wide. A structured event outside a
    // Dispatch-owned worktree is intentionally ignored, not treated as an
    // integration failure.
    if (!meta) return { captured: false, events: 0, projectionWarnings: 0 };

    const config = loadConfig(paths, meta.repositoryPath);
    index.upsertSession(meta);
    let projectionWarnings = 0;
    for (const draft of translation.value.drafts) {
      const result = await appendSessionEvent(
        paths,
        config,
        meta,
        draft,
        index,
      );
      if (result.projectionError) projectionWarnings += 1;
    }
    return {
      captured: true,
      events: translation.value.drafts.length,
      projectionWarnings,
    };
  } finally {
    index.close();
  }
}

export async function runHookProcess(
  args: readonly string[] = process.argv.slice(2),
): Promise<number> {
  const provider = args[0];
  if (provider !== "claude" || args.length !== 1) {
    console.error("Usage: dsp hook claude");
    return 2;
  }

  let input: unknown;
  try {
    input = JSON.parse(await Bun.stdin.text());
  } catch (error) {
    console.error(
      `dispatch hook: invalid JSON input: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  try {
    const result = await ingestHookPayload(provider, input);
    if (result.projectionWarnings > 0) {
      console.error(
        `dispatch hook: ${result.projectionWarnings} index update failed; run dsp reindex`,
      );
    }
    return 0;
  } catch (error) {
    // Claude treats exit 1 as a non-blocking hook failure. Capture failures
    // remain visible without turning observability into an authorization hook.
    console.error(
      `dispatch hook: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}
