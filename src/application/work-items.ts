import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { DispatchError, errorMessage } from "../core/errors";
import { createSortableId, isSortableId } from "../core/identity";
import {
  WorkLedger,
  fingerprintWork,
  normalizeWorkKey,
  normalizeWorkText,
  scoreWorkQuery,
  type WorkInsightKind,
  type WorkItem,
  type WorkState,
  type WorkStatus,
  type WorkTornTailRepairResult,
} from "../core/work";
import {
  ensureMachineId,
  ensureStateDirectories,
  pathKey,
  resolveDispatchPaths,
  sessionDirectory,
  type DispatchPaths,
  type Environment,
} from "../core/paths";
import { discoverPrimaryRepository } from "../core/worktree";
import { readSessionHistory } from "./ledger-service";
import {
  createSession,
  type CreateSessionOptions,
  type SessionMutationResult,
} from "./sessions";
import type { SessionMeta } from "./session-meta";

export const WORK_STATUSES: readonly WorkStatus[] = [
  "planned",
  "active",
  "blocked",
  "review",
  "done",
  "superseded",
];

export const WORK_INSIGHT_KINDS: readonly WorkInsightKind[] = [
  "decision",
  "learning",
  "risk",
  "question",
];

export interface WorkApplicationOptions {
  readonly paths?: DispatchPaths;
  readonly env?: Environment;
  readonly clock?: () => Date;
}

interface WorkContext {
  readonly paths: DispatchPaths;
  readonly env: Environment;
  readonly clock: () => Date;
}

export interface CreateWorkItemOptions extends WorkApplicationOptions {
  readonly repositoryPath?: string;
  readonly key: string;
  readonly title: string;
  readonly objective?: string;
  readonly externalRef?: string;
  readonly priority?: number;
}

export interface CreateWorkItemResult {
  readonly created: boolean;
  readonly item: WorkItem;
}

export interface ListWorkItemsOptions extends WorkApplicationOptions {
  readonly repositoryPath?: string;
  readonly status?: WorkStatus;
  readonly limit?: number;
}

export type AttemptEvidenceState =
  | "reserved"
  | "active"
  | "closed_unresolved"
  | "merged"
  | "discarded"
  | "abandoned"
  | "removed"
  | "create_failed"
  | "cancelled"
  | "inconsistent";

export interface WorkAttemptEvidence {
  readonly sid: string;
  readonly state: AttemptEvidenceState;
  readonly startedAt: string;
  readonly cancelledAt: string | null;
  readonly lastEventAt: string | null;
  readonly disposition: string | null;
  readonly corroborated: boolean;
}

export interface WorkItemBrief {
  readonly item: WorkItem;
  readonly attempts: readonly WorkAttemptEvidence[];
  readonly evidence: {
    readonly attempts: number;
    readonly active: number;
    readonly merged: number;
    readonly discarded: number;
    readonly unresolved: number;
  };
}

export interface WorkSearchMatch extends WorkItemBrief {
  readonly score: number;
  readonly sharedTokens: readonly string[];
}

export interface RepositoryWorkBrief {
  readonly repositoryPath: string;
  readonly query: string | null;
  readonly roadmap: {
    readonly active: readonly WorkItemBrief[];
    readonly blocked: readonly WorkItemBrief[];
    readonly review: readonly WorkItemBrief[];
    readonly next: readonly WorkItemBrief[];
  };
  readonly matches: readonly WorkSearchMatch[];
}

export interface StartWorkSessionOptions
  extends Omit<CreateSessionOptions, "sessionId" | "workId"> {
  readonly paths?: DispatchPaths;
  readonly env?: Environment;
  readonly clock?: () => Date;
  /** Test/integration seam; production callers use cryptographic sortable IDs. */
  readonly sessionIdFactory?: () => string;
}

export interface WorkSessionResult
  extends SessionMutationResult<SessionMeta> {
  readonly workId: string;
}

function context(options: WorkApplicationOptions): WorkContext {
  return {
    paths: options.paths ?? resolveDispatchPaths(options.env),
    env: options.env ?? process.env,
    clock: options.clock ?? (() => new Date()),
  };
}

function ledger(app: WorkContext): WorkLedger {
  ensureStateDirectories(app.paths);
  return new WorkLedger({
    eventsPath: app.paths.workEventsPath,
    machineId: ensureMachineId(app.paths),
    clock: app.clock,
    syncWrites: true,
  });
}

function requireWorkId(value: string): string {
  if (!isSortableId(value)) {
    throw new DispatchError(
      "work.id_invalid",
      "Work ID must be a canonical sortable ID.",
      { workId: value },
    );
  }
  return value;
}

function requireSessionId(value: string): string {
  if (!isSortableId(value)) {
    throw new DispatchError(
      "work.session_id_invalid",
      "Session ID must be a canonical sortable ID.",
      { sessionId: value },
    );
  }
  return value;
}

function requiredBoundedText(
  value: string,
  field: string,
  maximum: number,
): string {
  if (typeof value !== "string") {
    throw new DispatchError(
      `work.${field}_invalid`,
      `${field} must be text.`,
      { field },
    );
  }
  const normalized = normalizeWorkText(value);
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new DispatchError(
      `work.${field}_invalid`,
      `${field} must contain between 1 and ${maximum} characters.`,
      { field, maximum },
    );
  }
  return normalized;
}

function optionalBoundedText(
  value: string | undefined,
  field: string,
  maximum: number,
): string | null {
  if (value === undefined) return null;
  return requiredBoundedText(value, field, maximum);
}

function workItem(state: WorkState, wid: string): WorkItem {
  const item = state.items.get(requireWorkId(wid));
  if (!item) {
    throw new DispatchError(
      "work.not_found",
      `Work item ${wid} does not exist.`,
      { workId: wid },
    );
  }
  return item;
}

async function canonicalRepositoryPath(value: string): Promise<string> {
  return discoverPrimaryRepository(resolve(value));
}

function compareWork(left: WorkItem, right: WorkItem): number {
  return (
    left.priority - right.priority ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.wid.localeCompare(right.wid)
  );
}

function sameCreateIntent(
  item: WorkItem,
  input: {
    readonly title: string;
    readonly objective: string | null;
    readonly externalRef: string | null;
    readonly priority: number;
    readonly fingerprint: string;
  },
): boolean {
  return (
    item.title === input.title &&
    item.objective === input.objective &&
    item.externalRef === input.externalRef &&
    item.priority === input.priority &&
    item.fingerprint === input.fingerprint
  );
}

export async function createWorkItem(
  options: CreateWorkItemOptions,
): Promise<CreateWorkItemResult> {
  const app = context(options);
  const repositoryPath = await canonicalRepositoryPath(
    options.repositoryPath ?? process.cwd(),
  );
  const repositoryKey = pathKey(repositoryPath);
  let key: string;
  try {
    key = normalizeWorkKey(options.key);
  } catch (error) {
    throw new DispatchError(
      "work.key_invalid",
      errorMessage(error),
      { key: options.key },
      { cause: error },
    );
  }
  const title = requiredBoundedText(options.title, "title", 200);
  const objective = optionalBoundedText(options.objective, "objective", 4_000);
  const externalRef = optionalBoundedText(
    options.externalRef,
    "external_ref",
    500,
  );
  const priority = options.priority ?? 3;
  if (!Number.isSafeInteger(priority) || priority < 1 || priority > 5) {
    throw new DispatchError(
      "work.priority_invalid",
      "priority must be an integer from 1 through 5.",
      { priority },
    );
  }
  const fingerprint = fingerprintWork(
    repositoryKey,
    title,
    objective,
  );
  const wid = createSortableId();
  const workLedger = ledger(app);

  const transaction = await workLedger.transact((state) => {
    const items = [...state.items.values()];
    const existingKey = items.find(
      (item) => item.repositoryKey === repositoryKey && item.key === key,
    );
    if (existingKey) {
      if (
        sameCreateIntent(existingKey, {
          title,
          objective,
          externalRef,
          priority,
          fingerprint,
        })
      ) {
        return {
          inputs: [],
          value: { wid: existingKey.wid, created: false },
        };
      }
      throw new DispatchError(
        "work.key_conflict",
        `Work key ${key} already identifies ${existingKey.wid}.`,
        { key, workId: existingKey.wid },
      );
    }

    const duplicate = items.find(
      (item) =>
        item.repositoryKey === repositoryKey &&
        item.fingerprint === fingerprint,
    );
    if (duplicate) {
      throw new DispatchError(
        "work.duplicate",
        `The same normalized work intent already exists as ${duplicate.wid} (${duplicate.key}).`,
        { workId: duplicate.wid, key: duplicate.key, fingerprint },
      );
    }

    return {
      inputs: [
        {
          src: "user" as const,
          kind: "work.created" as const,
          data: {
            wid,
            repositoryPath,
            repositoryKey,
            key,
            title,
            objective,
            externalRef,
            priority,
            fingerprint,
          },
        },
      ],
      value: { wid, created: true },
    };
  });

  const state = await workLedger.read();
  return {
    created: transaction.value.created,
    item: workItem(state, transaction.value.wid),
  };
}

export async function listWorkItems(
  options: ListWorkItemsOptions = {},
): Promise<readonly WorkItem[]> {
  const app = context(options);
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) {
    throw new DispatchError(
      "work.limit_invalid",
      "Work list limit must be between 1 and 10000.",
      { limit },
    );
  }
  const repositoryKey = options.repositoryPath
    ? pathKey(await canonicalRepositoryPath(options.repositoryPath))
    : null;
  const state = await ledger(app).read();
  return [...state.items.values()]
    .filter(
      (item) =>
        (repositoryKey === null || item.repositoryKey === repositoryKey) &&
        (options.status === undefined || item.status === options.status),
    )
    .sort(compareWork)
    .slice(0, limit);
}

export async function repairWorkLedger(
  options: WorkApplicationOptions = {},
): Promise<WorkTornTailRepairResult> {
  return ledger(context(options)).repairTornTail();
}

export async function setWorkStatus(
  wid: string,
  status: WorkStatus,
  options: WorkApplicationOptions = {},
): Promise<WorkItem> {
  requireWorkId(wid);
  if (!WORK_STATUSES.includes(status)) {
    throw new DispatchError(
      "work.status_invalid",
      `Work status must be one of: ${WORK_STATUSES.join(", ")}.`,
      { status },
    );
  }
  const app = context(options);
  const workLedger = ledger(app);
  const initial = workItem(await workLedger.read(), wid);
  const requiresNoUnresolvedAttempt = [
    "planned",
    "done",
    "superseded",
  ].includes(status);
  const terminalAttempts = new Set(
    requiresNoUnresolvedAttempt
      ? (await evidenceForItem(app.paths, initial))
          .filter(attemptAllowsAnother)
          .map((attempt) => attempt.sid)
      : [],
  );
  await workLedger.transact((state) => {
    const current = workItem(state, wid);
    if (requiresNoUnresolvedAttempt) {
      const blocking = current.attempts.find(
        (attempt) =>
          attempt.cancelledAt === null && !terminalAttempts.has(attempt.sid),
      );
      if (blocking) {
        throw new DispatchError(
          "work.attempt_active",
          `Work item ${wid} has unresolved attempt ${blocking.sid} and cannot become ${status}.`,
          { workId: wid, sessionId: blocking.sid, status },
        );
      }
    }
    if (current.status === status) return { inputs: [], value: undefined };
    if (current.status === "superseded") {
      throw new DispatchError(
        "work.status_terminal",
        `Superseded work item ${wid} cannot transition to ${status}.`,
        { workId: wid, status },
      );
    }
    return {
      inputs: [
        {
          src: "user" as const,
          kind: "work.status.changed" as const,
          data: { wid, status },
        },
      ],
      value: undefined,
    };
  });
  return workItem(await workLedger.read(), wid);
}

async function attemptEvidence(
  paths: DispatchPaths,
  expectedWorkId: string,
  expectedRepositoryKey: string,
  attempt: WorkItem["attempts"][number],
): Promise<WorkAttemptEvidence> {
  if (attempt.cancelledAt !== null) {
    return {
      sid: attempt.sid,
      state: "cancelled",
      startedAt: attempt.startedAt,
      cancelledAt: attempt.cancelledAt,
      lastEventAt: null,
      disposition: null,
      corroborated: true,
    };
  }

  const history = await readSessionHistory(paths, attempt.sid);
  if (history.length === 0) {
    return {
      sid: attempt.sid,
      state: "reserved",
      startedAt: attempt.startedAt,
      cancelledAt: null,
      lastEventAt: null,
      disposition: null,
      corroborated: false,
    };
  }

  const origin = history[0];
  if (
    origin?.seq !== 1 ||
    origin.kind !== "session.created" ||
    origin.data.workId !== expectedWorkId ||
    typeof origin.data.repositoryPath !== "string" ||
    pathKey(origin.data.repositoryPath) !== expectedRepositoryKey
  ) {
    return {
      sid: attempt.sid,
      state: "inconsistent",
      startedAt: attempt.startedAt,
      cancelledAt: null,
      lastEventAt: history.at(-1)?.ts ?? null,
      disposition: null,
      corroborated: false,
    };
  }

  const outcomes = history.filter(
    (event) => event.kind === "outcome.recorded",
  );
  const outcome = outcomes.length === 1 ? outcomes[0] : undefined;
  const disposition =
    typeof outcome?.data.disposition === "string"
      ? outcome.data.disposition
      : null;
  const merged = history.some((event) => event.kind === "git.merged");
  const discarded = history.some((event) => event.kind === "git.discarded");
  const removed = history.some((event) => event.kind === "worktree.removed");
  const createFailed = history.some(
    (event) =>
      event.kind === "session.closed" &&
      event.data.reason === "worktree-create-failed",
  );
  const closed = history.some((event) => event.kind === "session.closed");

  let state: AttemptEvidenceState;
  let corroborated = false;
  if (outcomes.length > 1) {
    state = "inconsistent";
  } else if (merged && !discarded && disposition === "merged") {
    state = "merged";
    corroborated = true;
  } else if (merged || disposition === "merged") {
    state = "inconsistent";
  } else if (
    discarded &&
    (disposition === "discarded" || disposition === null)
  ) {
    state = "discarded";
    corroborated = true;
  } else if (discarded || disposition === "discarded") {
    state = "inconsistent";
  } else if (disposition === "abandoned") {
    state = "abandoned";
    corroborated = true;
  } else if (createFailed) {
    state = "create_failed";
    corroborated = true;
  } else if (outcome) {
    state = "inconsistent";
  } else if (removed) {
    state = "removed";
  } else if (closed) {
    state = "closed_unresolved";
  } else {
    state = "active";
  }

  return {
    sid: attempt.sid,
    state,
    startedAt: attempt.startedAt,
    cancelledAt: null,
    lastEventAt: history.at(-1)?.ts ?? null,
    disposition,
    corroborated,
  };
}

function attemptAllowsAnother(value: WorkAttemptEvidence): boolean {
  return [
    "merged",
    "discarded",
    "abandoned",
    "create_failed",
    "cancelled",
  ].includes(value.state);
}

async function evidenceForItem(
  paths: DispatchPaths,
  item: WorkItem,
): Promise<readonly WorkAttemptEvidence[]> {
  return Promise.all(
    item.attempts.map((attempt) =>
      attemptEvidence(paths, item.wid, item.repositoryKey, attempt),
    ),
  );
}

function summarizeEvidence(
  item: WorkItem,
  attempts: readonly WorkAttemptEvidence[],
): WorkItemBrief {
  const active = attempts.filter((attempt) => attempt.state === "active").length;
  const merged = attempts.filter((attempt) => attempt.state === "merged").length;
  const discarded = attempts.filter((attempt) =>
    ["discarded", "abandoned"].includes(attempt.state),
  ).length;
  return {
    item,
    attempts,
    evidence: {
      attempts: attempts.length,
      active,
      merged,
      discarded,
      unresolved: attempts.filter((attempt) => !attemptAllowsAnother(attempt)).length,
    },
  };
}

export async function getWorkItemBrief(
  wid: string,
  options: WorkApplicationOptions = {},
): Promise<WorkItemBrief> {
  const app = context(options);
  const item = workItem(await ledger(app).read(), wid);
  return summarizeEvidence(item, await evidenceForItem(app.paths, item));
}

export async function startWorkSession(
  wid: string,
  options: StartWorkSessionOptions = {},
): Promise<WorkSessionResult> {
  if (
    options.sessionIdFactory !== undefined &&
    typeof options.sessionIdFactory !== "function"
  ) {
    throw new DispatchError(
      "work.session_id_factory_invalid",
      "sessionIdFactory must be a function.",
    );
  }
  const app = context(options);
  const workLedger = ledger(app);
  const initial = workItem(await workLedger.read(), wid);
  const requestedRepository = await canonicalRepositoryPath(
    options.repositoryPath ?? initial.repositoryPath,
  );
  if (pathKey(requestedRepository) !== initial.repositoryKey) {
    throw new DispatchError(
      "work.repository_mismatch",
      `Work item ${wid} belongs to ${initial.repositoryPath}, not ${requestedRepository}.`,
      {
        workId: wid,
        repositoryPath: initial.repositoryPath,
        requestedRepository,
      },
    );
  }

  const priorEvidence = await evidenceForItem(app.paths, initial);
  const terminalAttempts = new Set(
    priorEvidence
      .filter(attemptAllowsAnother)
      .map((attempt) => attempt.sid),
  );
  const sessionIdFactory = options.sessionIdFactory ?? createSortableId;
  const { sessionIdFactory: _sessionIdFactory, ...sessionOptions } = options;

  for (let allocationAttempt = 1; allocationAttempt <= 32; allocationAttempt += 1) {
    const sid = requireSessionId(sessionIdFactory());
    if (existsSync(sessionDirectory(app.paths, sid))) continue;

    const reservation = await workLedger.transact((state) => {
      const sidAlreadyReserved = [...state.items.values()].some((item) =>
        item.attempts.some((attempt) => attempt.sid === sid),
      );
      if (sidAlreadyReserved) {
        return { inputs: [], value: false };
      }

      const current = workItem(state, wid);
      if (!(["planned", "active"] as const).includes(current.status as never)) {
        throw new DispatchError(
          "work.not_startable",
          `Work item ${wid} is ${current.status}; set it to planned or active before starting another attempt.`,
          { workId: wid, status: current.status },
        );
      }
      const blocking = current.attempts.find(
        (attempt) =>
          attempt.cancelledAt === null && !terminalAttempts.has(attempt.sid),
      );
      if (blocking) {
        throw new DispatchError(
          "work.attempt_active",
          `Work item ${wid} already has unresolved attempt ${blocking.sid}.`,
          { workId: wid, sessionId: blocking.sid },
        );
      }
      return {
        inputs: [
          {
            src: "dsp" as const,
            kind: "work.attempt.started" as const,
            data: { wid, sid },
          },
        ],
        value: true,
      };
    });
    if (!reservation.value) continue;

    try {
      const result = await createSession({
        ...sessionOptions,
        paths: app.paths,
        env: app.env,
        clock: app.clock,
        sessionId: sid,
        workId: wid,
        repositoryPath: requestedRepository,
        name: options.name ?? initial.title,
      });
      return { ...result, workId: wid };
    } catch (error) {
      let ownsDurableOrigin = false;
      let originUnreadable = false;
      try {
        const history = await readSessionHistory(app.paths, sid);
        const origin = history[0];
        ownsDurableOrigin =
          origin?.seq === 1 &&
          origin.kind === "session.created" &&
          origin.data.workId === wid &&
          typeof origin.data.repositoryPath === "string" &&
          pathKey(origin.data.repositoryPath) === initial.repositoryKey;
      } catch {
        // Corrupt or unreadable evidence is never safe to release implicitly.
        originUnreadable = true;
      }

      if (!ownsDurableOrigin && !originUnreadable) {
        try {
          await workLedger.transact((state) => {
            const current = workItem(state, wid);
            const attempt = current.attempts.find((item) => item.sid === sid);
            if (!attempt || attempt.cancelledAt !== null) {
              return { inputs: [], value: undefined };
            }
            return {
              inputs: [
                {
                  src: "dsp" as const,
                  kind: "work.attempt.cancelled" as const,
                  data: { wid, sid },
                },
              ],
              value: undefined,
            };
          });
        } catch (cancellationError) {
          throw new DispatchError(
            "work.session_start_uncertain",
            `Session ${sid} did not start, and its work reservation could not be cancelled.`,
            {
              workId: wid,
              sessionId: sid,
              cancellationError: errorMessage(cancellationError),
            },
            { cause: error },
          );
        }
        if (error instanceof DispatchError && error.code === "session.id_exists") {
          continue;
        }
      }
      throw error;
    }
  }

  throw new DispatchError(
    "work.session_id_exhausted",
    "Could not allocate an unused session ID after 32 attempts.",
    { workId: wid },
  );
}

export async function proposeWorkInsight(
  wid: string,
  kind: WorkInsightKind,
  bodyInput: string,
  options: WorkApplicationOptions & { readonly sessionId?: string } = {},
): Promise<WorkItem> {
  requireWorkId(wid);
  if (!WORK_INSIGHT_KINDS.includes(kind)) {
    throw new DispatchError(
      "work.insight_kind_invalid",
      `Insight kind must be one of: ${WORK_INSIGHT_KINDS.join(", ")}.`,
      { kind },
    );
  }
  const body = requiredBoundedText(bodyInput, "insight", 4_000);
  const sessionId = options.sessionId
    ? requireSessionId(options.sessionId)
    : null;
  const iid = createSortableId();
  const workLedger = ledger(context(options));
  await workLedger.transact((state) => {
    const current = workItem(state, wid);
    if (
      sessionId !== null &&
      !current.attempts.some((attempt) => attempt.sid === sessionId)
    ) {
      throw new DispatchError(
        "work.insight_session_mismatch",
        `Session ${sessionId} is not an attempt for work item ${wid}.`,
        { workId: wid, sessionId },
      );
    }
    return {
      inputs: [
        {
          src: "user" as const,
          kind: "work.insight.proposed" as const,
          data: { wid, iid, kind, body, sessionId },
        },
      ],
      value: undefined,
    };
  });
  return workItem(await workLedger.read(), wid);
}

async function briefItem(
  paths: DispatchPaths,
  item: WorkItem,
): Promise<WorkItemBrief> {
  return summarizeEvidence(item, await evidenceForItem(paths, item));
}

export async function briefRepositoryWork(
  query: string | undefined,
  options: WorkApplicationOptions & {
    readonly repositoryPath?: string;
    readonly limit?: number;
  } = {},
): Promise<RepositoryWorkBrief> {
  const app = context(options);
  const limit = options.limit ?? 10;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
    throw new DispatchError(
      "work.limit_invalid",
      "Work briefing limit must be between 1 and 100.",
      { limit },
    );
  }
  const repositoryPath = await canonicalRepositoryPath(
    options.repositoryPath ?? process.cwd(),
  );
  const repositoryKey = pathKey(repositoryPath);
  const items = [...(await ledger(app).read()).items.values()]
    .filter((item) => item.repositoryKey === repositoryKey)
    .sort(compareWork);
  const briefs = await Promise.all(items.map((item) => briefItem(app.paths, item)));
  const normalizedQuery = query?.trim() || null;
  const matches = normalizedQuery
    ? briefs
        .map((brief) => ({ ...brief, ...scoreWorkQuery(normalizedQuery, brief.item) }))
        .filter((match) => match.score > 0)
        .sort(
          (left, right) =>
            right.score - left.score || compareWork(left.item, right.item),
        )
        .slice(0, limit)
    : [];

  return {
    repositoryPath,
    query: normalizedQuery,
    roadmap: {
      active: briefs.filter((brief) => brief.item.status === "active").slice(0, limit),
      blocked: briefs.filter((brief) => brief.item.status === "blocked").slice(0, limit),
      review: briefs.filter((brief) => brief.item.status === "review").slice(0, limit),
      next: briefs
        .filter(
          (brief) =>
            brief.item.status === "planned" && brief.evidence.unresolved === 0,
        )
        .slice(0, limit),
    },
    matches,
  };
}
