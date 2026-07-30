import type { EventKind, JsonObject } from "../core/ledger";

/**
 * Alias kept at the port boundary so adapters depend on the canonical kind
 * vocabulary without depending on ledger implementation details.
 */
export type CanonicalKind = EventKind;

/**
 * The adapter-owned portion of a ledger event. Identity, sequencing, machine
 * provenance, and timestamps are assigned by the ledger append boundary.
 */
export interface AgentEventDraft {
  src: "hook";
  kind: EventKind;
  data: JsonObject;
  ext?: JsonObject;
}

export interface AgentHookTranslation {
  /** Working directory used by the hook command to resolve the Dispatch session. */
  cwd: string;
  /** Provider session identity retained only for correlation and diagnostics. */
  providerSessionId: string;
  drafts: AgentEventDraft[];
}

export interface AgentHookValidationIssue {
  /** JSON-style path into the untrusted hook payload. */
  path: string;
  message: string;
}

export type AgentHookTranslationResult =
  | {
      ok: true;
      value: AgentHookTranslation;
    }
  | {
      ok: false;
      issues: AgentHookValidationIssue[];
    };

export interface AgentHookTranslator {
  translate(input: unknown): AgentHookTranslationResult;
}
