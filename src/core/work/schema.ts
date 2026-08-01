import { isSortableId } from "../identity";
import { fingerprintWork, normalizeWorkKey, normalizeWorkText } from "./normalize";
import {
  WORK_EVENT_KINDS,
  WORK_EVENT_SCHEMA_VERSION,
  WORK_EVENT_SOURCES,
  WORK_INSIGHT_KINDS,
  WORK_STATUSES,
  type WorkCreatedData,
  type WorkEvent,
} from "./types";

const ENVELOPE_FIELDS = [
  "v",
  "id",
  "mid",
  "seq",
  "ts",
  "src",
  "kind",
  "data",
] as const;

const CREATED_FIELDS = [
  "wid",
  "repositoryPath",
  "repositoryKey",
  "key",
  "title",
  "objective",
  "externalRef",
  "priority",
  "fingerprint",
] as const;

const STATUS_FIELDS = ["wid", "status"] as const;
const ATTEMPT_FIELDS = ["wid", "sid"] as const;
const INSIGHT_FIELDS = [
  "wid",
  "iid",
  "kind",
  "body",
  "sessionId",
] as const;

const EVENT_KIND_SET = new Set<string>(WORK_EVENT_KINDS);
const EVENT_SOURCE_SET = new Set<string>(WORK_EVENT_SOURCES);
const STATUS_SET = new Set<string>(WORK_STATUSES);
const INSIGHT_KIND_SET = new Set<string>(WORK_INSIGHT_KINDS);
const CANONICAL_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

export class WorkEventValidationError extends Error {
  readonly field: string | undefined;

  constructor(message: string, field?: string, options?: ErrorOptions) {
    super(field === undefined ? message : `${field}: ${message}`, options);
    this.name = "WorkEventValidationError";
    this.field = field;
  }
}

export function assertWorkEventForWrite(
  value: unknown,
): asserts value is WorkEvent {
  validateWorkEvent(value);
}

export function parseWorkEvent(value: unknown): WorkEvent {
  validateWorkEvent(value);
  return value;
}

function validateWorkEvent(value: unknown): asserts value is WorkEvent {
  if (!isPlainObject(value)) {
    throw new WorkEventValidationError("event must be a JSON object");
  }
  assertExactFields(value, ENVELOPE_FIELDS, "event");

  if (value.v !== WORK_EVENT_SCHEMA_VERSION) {
    throw new WorkEventValidationError(
      `must equal schema version ${WORK_EVENT_SCHEMA_VERSION}`,
      "v",
    );
  }
  assertSortableIdentifier(value.id, "id");

  if (typeof value.mid !== "string" || value.mid.trim().length === 0) {
    throw new WorkEventValidationError("machine ID is required", "mid");
  }
  if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 1) {
    throw new WorkEventValidationError("must be a positive safe integer", "seq");
  }
  if (
    typeof value.ts !== "string" ||
    !CANONICAL_TIMESTAMP.test(value.ts) ||
    !isCanonicalDate(value.ts)
  ) {
    throw new WorkEventValidationError(
      "must be an ISO-8601 UTC timestamp with millisecond precision",
      "ts",
    );
  }
  if (typeof value.src !== "string" || !EVENT_SOURCE_SET.has(value.src)) {
    throw new WorkEventValidationError(
      `must be one of: ${WORK_EVENT_SOURCES.join(", ")}`,
      "src",
    );
  }
  if (typeof value.kind !== "string" || !EVENT_KIND_SET.has(value.kind)) {
    throw new WorkEventValidationError(
      `must be one of: ${WORK_EVENT_KINDS.join(", ")}`,
      "kind",
    );
  }
  if (!isPlainObject(value.data)) {
    throw new WorkEventValidationError("must be a JSON object", "data");
  }

  switch (value.kind) {
    case "work.created":
      validateCreatedData(value.data);
      break;
    case "work.status.changed":
      validateStatusData(value.data);
      break;
    case "work.attempt.started":
    case "work.attempt.cancelled":
      validateAttemptData(value.data);
      break;
    case "work.insight.proposed":
      validateInsightData(value.data);
      break;
    default:
      throw new WorkEventValidationError("unsupported event kind", "kind");
  }
}

function validateCreatedData(value: Record<string, unknown>): void {
  assertExactFields(value, CREATED_FIELDS, "data");
  assertSortableIdentifier(value.wid, "data.wid");
  assertNonEmptyString(value.repositoryPath, "data.repositoryPath");
  if ((value.repositoryPath as string).trim() !== value.repositoryPath) {
    throw new WorkEventValidationError(
      "must not have leading or trailing whitespace",
      "data.repositoryPath",
    );
  }

  assertNonEmptyString(value.repositoryKey, "data.repositoryKey");
  if ((value.repositoryKey as string).trim() !== value.repositoryKey) {
    throw new WorkEventValidationError(
      "must not have leading or trailing whitespace",
      "data.repositoryKey",
    );
  }
  assertCanonicalText(value.title, "data.title", false);
  assertNullableCanonicalText(value.objective, "data.objective");
  assertNullableCanonicalText(value.externalRef, "data.externalRef");

  if (typeof value.key !== "string") {
    throw new WorkEventValidationError("must be a string", "data.key");
  }
  let canonicalKey: string;
  try {
    canonicalKey = normalizeWorkKey(value.key);
  } catch (error) {
    throw new WorkEventValidationError(
      errorMessage(error),
      "data.key",
      { cause: error },
    );
  }
  if (canonicalKey !== value.key) {
    throw new WorkEventValidationError(
      `must be canonical; use ${JSON.stringify(canonicalKey)}`,
      "data.key",
    );
  }

  if (
    !Number.isSafeInteger(value.priority) ||
    (value.priority as number) < 1 ||
    (value.priority as number) > 5
  ) {
    throw new WorkEventValidationError("must be an integer from 1 through 5", "data.priority");
  }
  if (
    typeof value.fingerprint !== "string" ||
    !FINGERPRINT_PATTERN.test(value.fingerprint)
  ) {
    throw new WorkEventValidationError(
      "must be a lowercase SHA-256 hexadecimal digest",
      "data.fingerprint",
    );
  }

  const created = value as unknown as WorkCreatedData;
  const expectedFingerprint = fingerprintWork(
    created.repositoryKey,
    created.title,
    created.objective,
  );
  if (created.fingerprint !== expectedFingerprint) {
    throw new WorkEventValidationError(
      "does not match repositoryKey and normalized objective/title",
      "data.fingerprint",
    );
  }
}

function validateStatusData(value: Record<string, unknown>): void {
  assertExactFields(value, STATUS_FIELDS, "data");
  assertSortableIdentifier(value.wid, "data.wid");
  if (typeof value.status !== "string" || !STATUS_SET.has(value.status)) {
    throw new WorkEventValidationError(
      `must be one of: ${WORK_STATUSES.join(", ")}`,
      "data.status",
    );
  }
}

function validateAttemptData(value: Record<string, unknown>): void {
  assertExactFields(value, ATTEMPT_FIELDS, "data");
  assertSortableIdentifier(value.wid, "data.wid");
  assertSortableIdentifier(value.sid, "data.sid");
}

function validateInsightData(value: Record<string, unknown>): void {
  assertExactFields(value, INSIGHT_FIELDS, "data");
  assertSortableIdentifier(value.wid, "data.wid");
  assertSortableIdentifier(value.iid, "data.iid");
  if (typeof value.kind !== "string" || !INSIGHT_KIND_SET.has(value.kind)) {
    throw new WorkEventValidationError(
      `must be one of: ${WORK_INSIGHT_KINDS.join(", ")}`,
      "data.kind",
    );
  }
  assertCanonicalText(value.body, "data.body", false);
  if (value.sessionId !== null) {
    assertSortableIdentifier(value.sessionId, "data.sessionId");
  }
}

function assertNullableCanonicalText(value: unknown, field: string): void {
  if (value === null) return;
  assertCanonicalText(value, field, false);
}

function assertCanonicalText(
  value: unknown,
  field: string,
  allowEmpty: boolean,
): void {
  if (typeof value !== "string") {
    throw new WorkEventValidationError("must be a string", field);
  }
  const normalized = normalizeWorkText(value);
  if (!allowEmpty && normalized.length === 0) {
    throw new WorkEventValidationError("must not be empty", field);
  }
  if (normalized !== value) {
    throw new WorkEventValidationError("must use canonical normalized text", field);
  }
}

function assertNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WorkEventValidationError("must be a non-empty string", field);
  }
}

function assertSortableIdentifier(value: unknown, field: string): void {
  if (!isSortableId(value)) {
    throw new WorkEventValidationError("must be a canonical sortable ID", field);
  }
}

function assertExactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  field: string,
): void {
  for (const required of fields) {
    if (!Object.hasOwn(value, required)) {
      throw new WorkEventValidationError("required field is missing", `${field}.${required}`);
    }
  }

  const allowed = new Set(fields);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new WorkEventValidationError(
      `unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
      field,
    );
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new WorkEventValidationError("symbol fields are not JSON", field);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isCanonicalDate(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
