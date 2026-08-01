import { assertWorkEventForWrite } from "./schema";
import type {
  WorkAttempt,
  WorkCreatedEvent,
  WorkEvent,
  WorkInsightProposedEvent,
  WorkItem,
  WorkState,
  WorkStatusChangedEvent,
} from "./types";

export type WorkReductionErrorCode =
  | "invalid-sequence"
  | "duplicate-event-id"
  | "duplicate-work-id"
  | "duplicate-work-key"
  | "duplicate-work-fingerprint"
  | "missing-work"
  | "unchanged-status"
  | "superseded-status-terminal"
  | "attempt-status-invalid"
  | "duplicate-attempt"
  | "missing-attempt"
  | "attempt-already-cancelled"
  | "duplicate-insight";

export class WorkReductionError extends Error {
  readonly code: WorkReductionErrorCode;
  readonly eventId: string;
  readonly sequence: number;

  constructor(
    code: WorkReductionErrorCode,
    message: string,
    event: WorkEvent,
  ) {
    super(message);
    this.name = "WorkReductionError";
    this.code = code;
    this.eventId = event.id;
    this.sequence = event.seq;
  }
}

interface WorkStateBuilder {
  readonly items: Map<string, WorkItem>;
  readonly eventIds: Set<string>;
  readonly workKeyOwners: Map<string, string>;
  readonly fingerprintOwners: Map<string, string>;
  readonly attemptOwners: Map<string, string>;
  readonly insightOwners: Map<string, string>;
  lastSequence: number;
}

/** Reduces a complete, globally sequenced work event history. */
export function reduceWorkEvents(events: readonly WorkEvent[]): WorkState {
  const builder: WorkStateBuilder = {
    items: new Map(),
    eventIds: new Set(),
    workKeyOwners: new Map(),
    fingerprintOwners: new Map(),
    attemptOwners: new Map(),
    insightOwners: new Map(),
    lastSequence: 0,
  };

  for (const event of events) {
    applyWorkEvent(builder, event);
  }

  return {
    items: builder.items,
    lastSequence: builder.lastSequence,
  };
}

function applyWorkEvent(builder: WorkStateBuilder, event: WorkEvent): void {
  assertWorkEventForWrite(event);

  const expectedSequence = builder.lastSequence + 1;
  if (event.seq !== expectedSequence) {
    throw new WorkReductionError(
      "invalid-sequence",
      `Expected global sequence ${expectedSequence}, received ${event.seq}`,
      event,
    );
  }
  if (builder.eventIds.has(event.id)) {
    throw new WorkReductionError(
      "duplicate-event-id",
      `Event ID ${event.id} was already reduced`,
      event,
    );
  }

  switch (event.kind) {
    case "work.created":
      applyCreated(builder, event);
      break;
    case "work.status.changed":
      applyStatusChanged(builder, event);
      break;
    case "work.attempt.started":
      applyAttemptStarted(builder, event);
      break;
    case "work.attempt.cancelled":
      applyAttemptCancelled(builder, event);
      break;
    case "work.insight.proposed":
      applyInsightProposed(builder, event);
      break;
  }

  builder.eventIds.add(event.id);
  builder.lastSequence = event.seq;
}

function applyCreated(
  builder: WorkStateBuilder,
  event: WorkCreatedEvent,
): void {
  const { data } = event;
  if (builder.items.has(data.wid)) {
    throw new WorkReductionError(
      "duplicate-work-id",
      `Work item ${data.wid} already has an origin event`,
      event,
    );
  }

  const scopedKey = scopedIdentity(data.repositoryKey, data.key);
  const keyOwner = builder.workKeyOwners.get(scopedKey);
  if (keyOwner !== undefined) {
    throw new WorkReductionError(
      "duplicate-work-key",
      `Repository work key ${data.key} already belongs to work item ${keyOwner}`,
      event,
    );
  }

  const scopedFingerprint = scopedIdentity(
    data.repositoryKey,
    data.fingerprint,
  );
  const fingerprintOwner = builder.fingerprintOwners.get(scopedFingerprint);
  if (fingerprintOwner !== undefined) {
    throw new WorkReductionError(
      "duplicate-work-fingerprint",
      `Repository work fingerprint ${data.fingerprint} already belongs to work item ${fingerprintOwner}`,
      event,
    );
  }

  builder.items.set(data.wid, {
    wid: data.wid,
    repositoryPath: data.repositoryPath,
    repositoryKey: data.repositoryKey,
    key: data.key,
    title: data.title,
    objective: data.objective,
    externalRef: data.externalRef,
    priority: data.priority,
    fingerprint: data.fingerprint,
    status: "planned",
    createdAt: event.ts,
    updatedAt: event.ts,
    attempts: [],
    insights: [],
  });
  builder.workKeyOwners.set(scopedKey, data.wid);
  builder.fingerprintOwners.set(scopedFingerprint, data.wid);
}

function applyStatusChanged(
  builder: WorkStateBuilder,
  event: WorkStatusChangedEvent,
): void {
  const item = requireWork(builder, event.data.wid, event);
  if (item.status === event.data.status) {
    throw new WorkReductionError(
      "unchanged-status",
      `Work item ${item.wid} is already ${item.status}`,
      event,
    );
  }
  if (item.status === "superseded") {
    throw new WorkReductionError(
      "superseded-status-terminal",
      `Superseded work item ${item.wid} cannot transition to ${event.data.status}`,
      event,
    );
  }

  builder.items.set(item.wid, {
    ...item,
    status: event.data.status,
    updatedAt: event.ts,
  });
}

function applyAttemptStarted(
  builder: WorkStateBuilder,
  event: Extract<WorkEvent, { readonly kind: "work.attempt.started" }>,
): void {
  const item = requireWork(builder, event.data.wid, event);
  if (item.status !== "planned" && item.status !== "active") {
    throw new WorkReductionError(
      "attempt-status-invalid",
      `Work item ${item.wid} is ${item.status}; attempts require planned or active status`,
      event,
    );
  }
  const priorOwner = builder.attemptOwners.get(event.data.sid);
  if (priorOwner !== undefined) {
    throw new WorkReductionError(
      "duplicate-attempt",
      `Session ${event.data.sid} is already an attempt of work item ${priorOwner}`,
      event,
    );
  }

  const activatedWork = item.status === "planned";
  builder.items.set(item.wid, {
    ...item,
    status: activatedWork ? "active" : item.status,
    updatedAt: event.ts,
    attempts: [
      ...item.attempts,
      {
        sid: event.data.sid,
        startedAt: event.ts,
        cancelledAt: null,
        activatedWork,
      },
    ],
  });
  builder.attemptOwners.set(event.data.sid, item.wid);
}

function applyAttemptCancelled(
  builder: WorkStateBuilder,
  event: Extract<WorkEvent, { readonly kind: "work.attempt.cancelled" }>,
): void {
  const item = requireWork(builder, event.data.wid, event);
  const owner = builder.attemptOwners.get(event.data.sid);
  if (owner !== item.wid) {
    throw new WorkReductionError(
      "missing-attempt",
      owner === undefined
        ? `Session ${event.data.sid} is not a recorded work attempt`
        : `Session ${event.data.sid} belongs to work item ${owner}, not ${item.wid}`,
      event,
    );
  }

  const attemptIndex = item.attempts.findIndex(
    (attempt) => attempt.sid === event.data.sid,
  );
  const attempt = item.attempts[attemptIndex];
  if (attemptIndex < 0 || attempt === undefined) {
    throw new WorkReductionError(
      "missing-attempt",
      `Session ${event.data.sid} is not an attempt of work item ${item.wid}`,
      event,
    );
  }
  if (attempt.cancelledAt !== null) {
    throw new WorkReductionError(
      "attempt-already-cancelled",
      `Session ${event.data.sid} was already cancelled at ${attempt.cancelledAt}`,
      event,
    );
  }

  const attempts = [...item.attempts];
  const cancelledAttempt: WorkAttempt = {
    ...attempt,
    cancelledAt: event.ts,
  };
  attempts[attemptIndex] = cancelledAttempt;
  const otherUncancelledAttempt = attempts.some(
    (candidate) =>
      candidate.sid !== cancelledAttempt.sid && candidate.cancelledAt === null,
  );
  const restorePlanned =
    cancelledAttempt.activatedWork &&
    item.status === "active" &&
    !otherUncancelledAttempt;
  builder.items.set(item.wid, {
    ...item,
    status: restorePlanned ? "planned" : item.status,
    updatedAt: event.ts,
    attempts,
  });
}

function applyInsightProposed(
  builder: WorkStateBuilder,
  event: WorkInsightProposedEvent,
): void {
  const item = requireWork(builder, event.data.wid, event);
  const priorOwner = builder.insightOwners.get(event.data.iid);
  if (priorOwner !== undefined) {
    throw new WorkReductionError(
      "duplicate-insight",
      `Insight ${event.data.iid} already belongs to work item ${priorOwner}`,
      event,
    );
  }

  builder.items.set(item.wid, {
    ...item,
    updatedAt: event.ts,
    insights: [
      ...item.insights,
      {
        iid: event.data.iid,
        kind: event.data.kind,
        body: event.data.body,
        sessionId: event.data.sessionId,
        proposedAt: event.ts,
      },
    ],
  });
  builder.insightOwners.set(event.data.iid, item.wid);
}

function requireWork(
  builder: WorkStateBuilder,
  wid: string,
  event: WorkEvent,
): WorkItem {
  const item = builder.items.get(wid);
  if (item === undefined) {
    throw new WorkReductionError(
      "missing-work",
      `Work item ${wid} does not have an origin event`,
      event,
    );
  }
  return item;
}

function scopedIdentity(repositoryKey: string, value: string): string {
  return JSON.stringify([repositoryKey, value]);
}
