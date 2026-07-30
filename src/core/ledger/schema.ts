import { isSortableId } from "../identity";

export const EVENT_SCHEMA_VERSION = 1 as const;

export const CANONICAL_EVENT_SOURCES = [
  "hook",
  "sdk",
  "dsp",
  "user",
] as const;

export type EventSource = (typeof CANONICAL_EVENT_SOURCES)[number];

export const CANONICAL_EVENT_KINDS = [
  "session.created",
  "session.opened",
  "session.closed",
  "worktree.created",
  "worktree.provisioned",
  "worktree.removed",
  "agent.started",
  "agent.stopped",
  "agent.state",
  "turn.started",
  "turn.completed",
  "tool.called",
  "tool.result",
  "permission.requested",
  "permission.decided",
  "usage.recorded",
  "review.opened",
  "review.commented",
  "review.completed",
  "git.committed",
  "git.merged",
  "git.discarded",
  "outcome.recorded",
] as const;

export type EventKind = (typeof CANONICAL_EVENT_KINDS)[number];

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface CanonicalEvent {
  readonly v: typeof EVENT_SCHEMA_VERSION;
  readonly id: string;
  readonly sid: string;
  readonly mid: string;
  readonly seq: number;
  readonly ts: string;
  readonly src: EventSource;
  readonly kind: EventKind;
  readonly data: JsonObject;
  readonly ext: JsonObject;
}

/**
 * A valid canonical event read from disk. Unknown envelope fields remain on
 * the object so newer writers can be replayed without destructive downcasts.
 */
export type ReadableEvent = CanonicalEvent & {
  readonly [key: string]: JsonValue;
};

const REQUIRED_FIELDS = [
  "v",
  "id",
  "sid",
  "mid",
  "seq",
  "ts",
  "src",
  "kind",
  "data",
  "ext",
] as const;

const REQUIRED_FIELD_SET = new Set<string>(REQUIRED_FIELDS);
const SOURCE_SET = new Set<string>(CANONICAL_EVENT_SOURCES);
const KIND_SET = new Set<string>(CANONICAL_EVENT_KINDS);
const CANONICAL_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export class EventValidationError extends Error {
  readonly field: string | undefined;

  constructor(message: string, field?: string, options?: ErrorOptions) {
    super(field === undefined ? message : `${field}: ${message}`, options);
    this.name = "EventValidationError";
    this.field = field;
  }
}

/**
 * Validates the strict writer contract. Every canonical envelope field must
 * be present and no additional envelope field is accepted.
 */
export function assertCanonicalEventForWrite(
  value: unknown,
): asserts value is CanonicalEvent {
  validateCanonicalEvent(value, false);
}

/**
 * Validates known version-1 fields while retaining any unknown envelope
 * fields verbatim, matching the architecture's tolerant-reader rule.
 */
export function parseCanonicalEventForRead(value: unknown): ReadableEvent {
  validateCanonicalEvent(value, true);
  return value as ReadableEvent;
}

function validateCanonicalEvent(
  value: unknown,
  allowUnknownFields: boolean,
): asserts value is CanonicalEvent {
  if (!isPlainObject(value)) {
    throw new EventValidationError("event must be a JSON object");
  }

  for (const field of REQUIRED_FIELDS) {
    if (!Object.hasOwn(value, field)) {
      throw new EventValidationError("required field is missing", field);
    }
  }

  const keys = Object.keys(value);
  if (!allowUnknownFields) {
    const unknownFields = keys.filter((key) => !REQUIRED_FIELD_SET.has(key));
    if (unknownFields.length > 0) {
      throw new EventValidationError(
        `unknown envelope field${unknownFields.length === 1 ? "" : "s"}: ${unknownFields.join(", ")}`,
      );
    }
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new EventValidationError("symbol envelope fields are not JSON");
  }

  if (value.v !== EVENT_SCHEMA_VERSION) {
    throw new EventValidationError(
      `must equal schema version ${EVENT_SCHEMA_VERSION}`,
      "v",
    );
  }

  if (!isSortableId(value.id)) {
    throw new EventValidationError("must be a canonical sortable ID", "id");
  }

  if (!isSortableId(value.sid)) {
    throw new EventValidationError("must be a canonical sortable ID", "sid");
  }

  if (typeof value.mid !== "string" || value.mid.trim().length === 0) {
    throw new EventValidationError("machine ID is required", "mid");
  }

  if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 1) {
    throw new EventValidationError(
      "must be a positive safe integer",
      "seq",
    );
  }

  if (
    typeof value.ts !== "string" ||
    !CANONICAL_TIMESTAMP.test(value.ts) ||
    !isCanonicalDate(value.ts)
  ) {
    throw new EventValidationError(
      "must be an ISO-8601 UTC timestamp with millisecond precision",
      "ts",
    );
  }

  if (typeof value.src !== "string" || !SOURCE_SET.has(value.src)) {
    throw new EventValidationError(
      `must be one of: ${CANONICAL_EVENT_SOURCES.join(", ")}`,
      "src",
    );
  }

  if (typeof value.kind !== "string" || !KIND_SET.has(value.kind)) {
    throw new EventValidationError(
      `must be one of: ${CANONICAL_EVENT_KINDS.join(", ")}`,
      "kind",
    );
  }

  if (!isPlainObject(value.data)) {
    throw new EventValidationError("must be a JSON object", "data");
  }
  assertJsonValue(value.data, "data");

  if (!isPlainObject(value.ext)) {
    throw new EventValidationError("must be a JSON object", "ext");
  }
  assertJsonValue(value.ext, "ext");
  for (const [namespace, providerData] of Object.entries(value.ext)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(namespace)) {
      throw new EventValidationError(
        "namespace must be a lowercase provider identifier",
        `ext.${namespace}`,
      );
    }
    if (!isPlainObject(providerData)) {
      throw new EventValidationError(
        "provider extension must be a JSON object",
        `ext.${namespace}`,
      );
    }
  }

  if (allowUnknownFields) {
    for (const key of keys) {
      if (!REQUIRED_FIELD_SET.has(key)) {
        assertJsonValue(value[key], key);
      }
    }
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
  return (
    Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
  );
}

function assertJsonValue(
  value: unknown,
  field: string,
  ancestors = new WeakSet<object>(),
): asserts value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new EventValidationError("must contain finite JSON numbers", field);
    }
    return;
  }

  if (typeof value !== "object") {
    throw new EventValidationError("must contain only JSON values", field);
  }

  if (ancestors.has(value)) {
    throw new EventValidationError("must not contain circular values", field);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        assertJsonValue(value[index], `${field}[${index}]`, ancestors);
      }
      return;
    }

    if (!isPlainObject(value)) {
      throw new EventValidationError(
        "must contain only plain JSON objects",
        field,
      );
    }

    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new EventValidationError("must not contain symbol keys", field);
    }

    for (const [key, nestedValue] of Object.entries(value)) {
      assertJsonValue(nestedValue, `${field}.${key}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}
