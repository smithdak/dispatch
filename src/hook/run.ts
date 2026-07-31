import { loadConfig } from "../core/config";
import { SessionIndex } from "../core/index";
import { withExclusiveFileLock } from "../core/ledger";
import {
  ensureStateDirectories,
  resolveDispatchPaths,
} from "../core/paths";
import { translateHook, type HookProvider } from "../adapters/registry";
import {
  appendSessionEvent,
  readSessionHistory,
  resolveSessionMetaByPath,
} from "../application/ledger-service";
import { sessionEventsPath } from "../application/session-meta";

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
  let index: SessionIndex | undefined;
  let projectionWarnings = 0;
  try {
    let meta;
    try {
      index = new SessionIndex(paths.indexPath);
      meta = await resolveSessionMetaByPath(
        paths,
        translation.value.cwd,
        index,
      );
    } catch {
      try {
        index?.close();
      } catch {
        // Preserve the projection failure as a warning; the ledger fallback
        // below remains the authoritative capture path.
      }
      index = undefined;
      projectionWarnings += 1;
      meta = await resolveSessionMetaByPath(
        paths,
        translation.value.cwd,
        null,
      );
    }
    // Hooks may be installed user-wide. A structured event outside a
    // Dispatch-owned worktree is intentionally ignored, not treated as an
    // integration failure.
    if (!meta) return { captured: false, events: 0, projectionWarnings };

    const config = loadConfig(paths, meta.repositoryPath);
    return withExclusiveFileLock(
      `${sessionEventsPath(paths, meta.sid)}.lifecycle`,
      async () => {
        const history = await readSessionHistory(paths, meta.sid);
        const terminal = history.some(
          (event) =>
            event.kind === "session.closed" ||
            event.kind === "worktree.removed",
        );
        if (terminal) {
          return { captured: false, events: 0, projectionWarnings };
        }

        if (index) {
          try {
            index.upsertSession(meta);
          } catch {
            try {
              index.close();
            } catch {
              // The projection is already unusable; capture still proceeds.
            }
            index = undefined;
            projectionWarnings += 1;
          }
        }

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
      },
      { timeoutMs: config.ledger.lockTimeoutMs },
    );
  } finally {
    try {
      index?.close();
    } catch {
      // Projection close failures cannot invalidate a committed hook event.
    }
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
