export {
  CANONICAL_EVENT_KINDS,
  CANONICAL_EVENT_SOURCES,
  EVENT_SCHEMA_VERSION,
  EventValidationError,
  assertCanonicalEventForWrite,
  parseCanonicalEventForRead,
} from "./schema";

export type {
  CanonicalEvent,
  EventKind,
  EventSource,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  ReadableEvent,
} from "./schema";

export { LockTimeoutError, withExclusiveFileLock } from "./lock";
export type { ExclusiveFileLockOptions } from "./lock";

export {
  JsonlLedger,
  LedgerCorruptionError,
  readLastLedgerEvent,
  recoverLastSequence,
  replayLedger,
} from "./ledger";

export type {
  AppendEventInput,
  JsonlLedgerOptions,
  ReplayIssue,
  ReplayIssueCode,
  ReplayOptions,
  ReplayResult,
} from "./ledger";
