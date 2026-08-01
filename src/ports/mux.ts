export const MUX_TARGET_LEGACY_VERSION = 1 as const;
export const MUX_TARGET_VERSION = 2 as const;

export interface MuxServerNamespace {
  readonly session: string | null;
  readonly socket: string;
}

/**
 * Persisted identity for one mux-owned terminal generation.
 *
 * Every identifier is an opaque backend handle. Display numbers and labels
 * are intentionally excluded because they are not stable identities.
 */
export interface MuxTargetV1 {
  readonly version: typeof MUX_TARGET_LEGACY_VERSION;
  readonly backend: "herdr";
  readonly protocol: number;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly paneId: string;
  readonly terminalId: string;
  readonly canonicalCwd: string;
}

export interface MuxTargetV2 {
  readonly version: typeof MUX_TARGET_VERSION;
  readonly backend: "herdr";
  readonly protocol: number;
  readonly server: MuxServerNamespace;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly paneId: string;
  readonly terminalId: string;
  readonly canonicalCwd: string;
}

export type MuxTarget = MuxTargetV1 | MuxTargetV2;

export interface MuxCapabilities {
  readonly backend: "herdr";
  readonly executable: string;
  readonly channel: string;
  readonly clientVersion: string;
  readonly serverVersion: string;
  readonly protocol: number;
  readonly server: MuxServerNamespace;
  readonly detachedServerDaemon: boolean;
  readonly liveHandoff: boolean;
}

export interface MuxDiscoveryRequest {
  readonly logicalKey: string;
  readonly canonicalCwd: string;
}

export type MuxDiscovery =
  | { readonly kind: "none" }
  | { readonly kind: "one"; readonly target: MuxTarget }
  | {
      readonly kind: "ambiguous";
      readonly candidates: readonly MuxTarget[];
    };

export interface MuxEnsureRequest extends MuxDiscoveryRequest {
  readonly environment?: Readonly<Record<string, string>>;
}

export interface MuxEnsureResult {
  readonly target: MuxTarget;
  readonly disposition: "created" | "recovered";
}

export type MuxStatus =
  | {
      readonly state: "running";
      readonly target: MuxTarget;
      readonly focused: boolean;
      readonly agentStatus?: string;
    }
  | {
      readonly state: "absent";
      readonly target: MuxTarget;
    };

export interface MuxCloseResult {
  readonly outcome: "closed" | "already_absent";
  readonly target: MuxTarget;
}

/**
 * One private prompt submission to an already-receipted terminal generation.
 *
 * `text` is an ephemeral transport value. Implementations must not place it in
 * process argv, environment variables, durable receipts, or error details.
 * `promptId` is caller-assigned so the durable intent and Herdr wire request
 * can use one correlation identity.
 */
export interface MuxPromptRequest {
  readonly promptId: string;
  readonly target: MuxTargetV2;
  readonly text: string;
}

export interface MuxPromptResult {
  readonly promptId: string;
  readonly target: MuxTargetV2;
  readonly agentStatus: string;
}

export type MuxErrorCode =
  | "ambiguous"
  | "conflict"
  | "unavailable"
  | "incompatible"
  | "outcome_unknown"
  | "invalid_response";

export class MuxError extends Error {
  readonly code: MuxErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: MuxErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MuxError";
    this.code = code;
    this.details = details;
  }
}

export interface MuxPort {
  probe(): Promise<MuxCapabilities>;
  discover(request: MuxDiscoveryRequest): Promise<MuxDiscovery>;
  ensure(request: MuxEnsureRequest): Promise<MuxEnsureResult>;
  status(target: MuxTarget): Promise<MuxStatus>;
  reconnect(target: MuxTarget): Promise<MuxStatus>;
  close(target: MuxTarget): Promise<MuxCloseResult>;
}

/**
 * Prompting is a separate capability so lifecycle-only mux fakes and backends
 * do not accidentally claim a private input transport. Implementations must
 * throw `MuxError("outcome_unknown", ...)` whenever zero backend mutation
 * cannot be proved, including for structured errors returned after a write.
 */
export interface MuxPromptPort {
  prompt(request: MuxPromptRequest): Promise<MuxPromptResult>;
}
