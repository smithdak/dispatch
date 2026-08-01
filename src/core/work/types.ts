import type { JsonObject } from "../ledger";

export const WORK_EVENT_SCHEMA_VERSION = 1 as const;

export const WORK_EVENT_KINDS = [
  "work.created",
  "work.status.changed",
  "work.attempt.started",
  "work.attempt.cancelled",
  "work.insight.proposed",
] as const;

export type WorkEventKind = (typeof WORK_EVENT_KINDS)[number];

export const WORK_STATUSES = [
  "planned",
  "active",
  "blocked",
  "review",
  "done",
  "superseded",
] as const;

export type WorkStatus = (typeof WORK_STATUSES)[number];

export const WORK_INSIGHT_KINDS = [
  "decision",
  "learning",
  "risk",
  "question",
] as const;

export type WorkInsightKind = (typeof WORK_INSIGHT_KINDS)[number];

export const WORK_EVENT_SOURCES = ["hook", "sdk", "dsp", "user"] as const;

export type WorkEventSource = (typeof WORK_EVENT_SOURCES)[number];

export interface WorkCreatedData extends JsonObject {
  readonly wid: string;
  readonly repositoryPath: string;
  readonly repositoryKey: string;
  readonly key: string;
  readonly title: string;
  readonly objective: string | null;
  readonly externalRef: string | null;
  readonly priority: number;
  readonly fingerprint: string;
}

export interface WorkStatusChangedData extends JsonObject {
  readonly wid: string;
  readonly status: WorkStatus;
}

export interface WorkAttemptData extends JsonObject {
  readonly wid: string;
  readonly sid: string;
}

export interface WorkInsightProposedData extends JsonObject {
  readonly wid: string;
  readonly iid: string;
  readonly kind: WorkInsightKind;
  readonly body: string;
  readonly sessionId: string | null;
}

interface WorkEventBase {
  readonly v: typeof WORK_EVENT_SCHEMA_VERSION;
  readonly id: string;
  readonly mid: string;
  readonly seq: number;
  readonly ts: string;
  readonly src: WorkEventSource;
}

export interface WorkCreatedEvent extends WorkEventBase {
  readonly kind: "work.created";
  readonly data: WorkCreatedData;
}

export interface WorkStatusChangedEvent extends WorkEventBase {
  readonly kind: "work.status.changed";
  readonly data: WorkStatusChangedData;
}

export interface WorkAttemptStartedEvent extends WorkEventBase {
  readonly kind: "work.attempt.started";
  readonly data: WorkAttemptData;
}

export interface WorkAttemptCancelledEvent extends WorkEventBase {
  readonly kind: "work.attempt.cancelled";
  readonly data: WorkAttemptData;
}

export interface WorkInsightProposedEvent extends WorkEventBase {
  readonly kind: "work.insight.proposed";
  readonly data: WorkInsightProposedData;
}

export type WorkEvent =
  | WorkCreatedEvent
  | WorkStatusChangedEvent
  | WorkAttemptStartedEvent
  | WorkAttemptCancelledEvent
  | WorkInsightProposedEvent;

export type WorkEventInput = WorkEvent extends infer Event
  ? Event extends WorkEvent
    ? Pick<Event, "src" | "kind" | "data">
    : never
  : never;

export interface WorkAttempt {
  readonly sid: string;
  readonly startedAt: string;
  readonly cancelledAt: string | null;
  /** True when this attempt moved its work item from planned to active. */
  readonly activatedWork: boolean;
}

export interface WorkInsight {
  readonly iid: string;
  readonly kind: WorkInsightKind;
  readonly body: string;
  readonly sessionId: string | null;
  readonly proposedAt: string;
}

export interface WorkItem {
  readonly wid: string;
  readonly repositoryPath: string;
  readonly repositoryKey: string;
  readonly key: string;
  readonly title: string;
  readonly objective: string | null;
  readonly externalRef: string | null;
  readonly priority: number;
  readonly fingerprint: string;
  readonly status: WorkStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly attempts: readonly WorkAttempt[];
  readonly insights: readonly WorkInsight[];
}

export interface WorkState {
  readonly items: ReadonlyMap<string, WorkItem>;
  readonly lastSequence: number;
}

export interface WorkQueryScore {
  /** Jaccard overlap in the closed range 0..1. */
  readonly score: number;
  readonly sharedTokens: readonly string[];
}
