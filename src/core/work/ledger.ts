import { open, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createSortableId, isSortableId } from "../identity";
import {
  type ExclusiveFileLockOptions,
  withExclusiveFileLock,
} from "../ledger";
import { reduceWorkEvents, WorkReductionError } from "./reducer";
import { assertWorkEventForWrite, parseWorkEvent } from "./schema";
import {
  WORK_EVENT_SCHEMA_VERSION,
  type WorkEvent,
  type WorkEventInput,
  type WorkState,
} from "./types";

export type WorkReplayIssueCode =
  | "malformed-record"
  | "duplicate-event-id"
  | "duplicate-sequence"
  | "sequence-gap"
  | "sequence-regression"
  | "invalid-transition";

export interface WorkReplayIssue {
  readonly code: WorkReplayIssueCode;
  readonly line: number;
  readonly message: string;
  readonly eventId?: string;
  readonly sequence?: number;
  readonly expectedSequence?: number;
}

export interface WorkReplayResult {
  readonly events: readonly WorkEvent[];
  readonly issues: readonly WorkReplayIssue[];
  readonly lastSequence: number;
}

export interface WorkLedgerOptions {
  readonly eventsPath: string;
  readonly machineId: string;
  readonly clock?: () => Date;
  readonly idFactory?: () => string;
  readonly syncWrites?: boolean;
  readonly lock?: ExclusiveFileLockOptions;
}

export interface WorkTransactionProposal<T> {
  readonly inputs: readonly WorkEventInput[];
  readonly value: T;
}

export interface WorkTransactionCommit<T> {
  readonly events: readonly WorkEvent[];
  readonly value: T;
}

export interface WorkTornTailRepairResult {
  readonly repaired: boolean;
  readonly bytesRemoved: number;
  readonly lastSequence: number;
}

const UNCOMMITTED_TAIL_MESSAGE =
  "Final work ledger record is not newline-terminated and is not committed";

export class WorkLedgerCorruptionError extends Error {
  readonly eventsPath: string;
  readonly issues: readonly WorkReplayIssue[];

  constructor(eventsPath: string, issues: readonly WorkReplayIssue[]) {
    super(
      `Work ledger ${eventsPath} contains ${issues.length} replay issue${issues.length === 1 ? "" : "s"}; refusing to continue`,
    );
    this.name = "WorkLedgerCorruptionError";
    this.eventsPath = eventsPath;
    this.issues = issues;
  }
}

/**
 * One append-only ledger for the complete work domain. Sequence allocation,
 * policy inspection, validation, and append are serialized by one file lock.
 */
export class WorkLedger {
  readonly eventsPath: string;
  readonly machineId: string;

  readonly #clock: () => Date;
  readonly #idFactory: () => string;
  readonly #syncWrites: boolean;
  readonly #lockOptions: ExclusiveFileLockOptions;

  constructor(options: WorkLedgerOptions) {
    if (
      typeof options.eventsPath !== "string" ||
      options.eventsPath.trim().length === 0
    ) {
      throw new TypeError("eventsPath is required");
    }
    if (
      typeof options.machineId !== "string" ||
      options.machineId.trim().length === 0
    ) {
      throw new TypeError("machineId is required");
    }
    if (options.clock !== undefined && typeof options.clock !== "function") {
      throw new TypeError("clock must be a function");
    }
    if (
      options.idFactory !== undefined &&
      typeof options.idFactory !== "function"
    ) {
      throw new TypeError("idFactory must be a function");
    }

    this.eventsPath = options.eventsPath;
    this.machineId = options.machineId;
    this.#clock = options.clock ?? (() => new Date());
    this.#idFactory = options.idFactory ?? (() => createSortableId());
    this.#syncWrites = options.syncWrites ?? true;
    this.#lockOptions = options.lock ?? {};
  }

  async read(): Promise<WorkState> {
    return withExclusiveFileLock(
      this.eventsPath,
      async () => this.#readUnlocked(),
      this.#lockOptions,
    );
  }

  async state(): Promise<WorkState> {
    return this.read();
  }

  async readState(): Promise<WorkState> {
    return this.read();
  }

  async replay(): Promise<WorkReplayResult> {
    return withExclusiveFileLock(
      this.eventsPath,
      async () => {
        await this.#stabilizeNamespace();
        return replayWorkLedger(this.eventsPath);
      },
      this.#lockOptions,
    );
  }

  /**
   * Removes only a final non-newline suffix. Committed schema, sequence, or
   * domain corruption is never rewritten and causes this operation to fail.
   */
  async repairTornTail(): Promise<WorkTornTailRepairResult> {
    return withExclusiveFileLock(
      this.eventsPath,
      async () => {
        await this.#stabilizeNamespace();
        return repairTornTailUnlocked(this.eventsPath);
      },
      this.#lockOptions,
    );
  }

  async append(input: WorkEventInput): Promise<WorkEvent> {
    const committed = await this.transact(() => ({
      inputs: [input],
      value: undefined,
    }));
    const event = committed.events[0];
    if (event === undefined) {
      throw new Error("Work ledger append did not produce an event");
    }
    return event;
  }

  async transact<T>(
    callback: (state: WorkState) => WorkTransactionProposal<T>,
  ): Promise<WorkTransactionCommit<T>> {
    if (typeof callback !== "function") {
      throw new TypeError("transaction callback must be a function");
    }

    return withExclusiveFileLock(
      this.eventsPath,
      async () => {
        await this.#stabilizeNamespace();
        const replay = await replayWorkLedger(this.eventsPath);
        assertHealthyReplay(this.eventsPath, replay);
        const state = reduceWorkEvents(replay.events);

        const proposal = callback(state);
        if (isPromiseLike(proposal)) {
          throw new TypeError("transaction callback must be synchronous");
        }
        if (!isPlainObject(proposal) || !Array.isArray(proposal.inputs)) {
          throw new TypeError(
            "transaction callback must return { inputs: WorkEventInput[], value }",
          );
        }

        const inputCount = proposal.inputs.length;
        if (inputCount > 1) {
          throw new RangeError(
            "work ledger transactions may append at most one event",
          );
        }
        if (replay.lastSequence > Number.MAX_SAFE_INTEGER - inputCount) {
          throw new RangeError("Work ledger sequence exhausted the safe integer range");
        }

        const seenIds = new Set(replay.events.map((event) => event.id));
        const events: WorkEvent[] = [];
        for (let index = 0; index < inputCount; index += 1) {
          const input = proposal.inputs[index];
          if (!isPlainObject(input)) {
            throw new TypeError(`transaction input ${index} must be an object`);
          }
          const timestamp = this.#clock();
          if (
            !(timestamp instanceof Date) ||
            !Number.isFinite(timestamp.getTime())
          ) {
            throw new TypeError("clock must return a valid Date");
          }

          const candidate: unknown = {
            v: WORK_EVENT_SCHEMA_VERSION,
            id: this.#allocateEventId(seenIds),
            mid: this.machineId,
            seq: replay.lastSequence + index + 1,
            ts: timestamp.toISOString(),
            src: input.src,
            kind: input.kind,
            data: input.data,
          };
          assertWorkEventForWrite(candidate);
          seenIds.add(candidate.id);
          events.push(candidate);
        }

        // Validate the whole proposed domain transition before the first byte
        // is appended. Callback or validation failures therefore write nothing.
        reduceWorkEvents([...replay.events, ...events]);
        if (events.length > 0) {
          await appendWorkEvents(this.eventsPath, events, this.#syncWrites);
        }

        return { events, value: proposal.value };
      },
      this.#lockOptions,
    );
  }

  async #readUnlocked(): Promise<WorkState> {
    await this.#stabilizeNamespace();
    const replay = await replayWorkLedger(this.eventsPath);
    assertHealthyReplay(this.eventsPath, replay);
    return reduceWorkEvents(replay.events);
  }

  #allocateEventId(seenIds: ReadonlySet<string>): string {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const id = this.#idFactory();
      if (!isSortableId(id)) {
        throw new TypeError("idFactory must return a canonical sortable ID");
      }
      if (!seenIds.has(id)) return id;
    }
    throw new Error("Unable to allocate a unique work event ID after 32 attempts");
  }

  async #stabilizeNamespace(): Promise<void> {
    if (!this.#syncWrites) return;
    // A prior process can die while publishing either the ledger file or any
    // recursively-created ancestor. Re-sync the complete visible chain before
    // replay so an idempotent retry cannot acknowledge state beneath a still-
    // volatile directory entry.
    await syncDirectoryChain(dirname(this.eventsPath));
  }
}

/** Replays the global work JSONL without modifying it. */
export async function replayWorkLedger(
  eventsPath: string,
): Promise<WorkReplayResult> {
  if (typeof eventsPath !== "string" || eventsPath.trim().length === 0) {
    throw new TypeError("eventsPath is required");
  }

  let file: FileHandle;
  try {
    file = await open(eventsPath, "r");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return { events: [], issues: [], lastSequence: 0 };
    }
    throw error;
  }

  const events: WorkEvent[] = [];
  const issues: WorkReplayIssue[] = [];
  const seenIds = new Set<string>();
  const seenSequences = new Set<number>();
  const eventLines = new Map<WorkEvent, number>();
  let expectedSequence = 1;
  let lastSequence = 0;
  const fileStat = await file.stat();
  let committedSize = fileStat.size;

  if (fileStat.size > 0) {
    const terminalByte = new Uint8Array(1);
    await readFully(file, terminalByte, fileStat.size - 1);
    if (terminalByte[0] !== 0x0a) {
      issues.push({
        code: "malformed-record",
        line: 0,
        message: UNCOMMITTED_TAIL_MESSAGE,
      });
      committedSize = await committedPrefixSize(file, fileStat.size);
    }
  }

  if (committedSize === 0) {
    await file.close();
    return { events, issues, lastSequence };
  }

  const stream = file.createReadStream({
    encoding: "utf8",
    autoClose: false,
    start: 0,
    end: committedSize - 1,
  });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;

  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (line.trim().length === 0) {
        issues.push({
          code: "malformed-record",
          line: lineNumber,
          message: "Work ledger line is empty",
        });
        continue;
      }

      let event: WorkEvent;
      try {
        event = parseWorkEvent(JSON.parse(line));
      } catch (error) {
        issues.push({
          code: "malformed-record",
          line: lineNumber,
          message: errorMessage(error),
        });
        continue;
      }

      events.push(event);
      eventLines.set(event, lineNumber);
      lastSequence = Math.max(lastSequence, event.seq);

      if (seenIds.has(event.id)) {
        issues.push({
          code: "duplicate-event-id",
          line: lineNumber,
          message: `Event ID ${event.id} was already observed`,
          eventId: event.id,
          sequence: event.seq,
        });
      } else {
        seenIds.add(event.id);
      }

      if (seenSequences.has(event.seq)) {
        issues.push({
          code: "duplicate-sequence",
          line: lineNumber,
          message: `Global sequence ${event.seq} was already observed`,
          eventId: event.id,
          sequence: event.seq,
          expectedSequence,
        });
      } else if (event.seq > expectedSequence) {
        issues.push({
          code: "sequence-gap",
          line: lineNumber,
          message: `Expected global sequence ${expectedSequence}, received ${event.seq}`,
          eventId: event.id,
          sequence: event.seq,
          expectedSequence,
        });
      } else if (event.seq < expectedSequence) {
        issues.push({
          code: "sequence-regression",
          line: lineNumber,
          message: `Global sequence regressed from ${expectedSequence} to ${event.seq}`,
          eventId: event.id,
          sequence: event.seq,
          expectedSequence,
        });
      }

      seenSequences.add(event.seq);
      expectedSequence = Math.max(expectedSequence, event.seq + 1);
    }
  } finally {
    lines.close();
    stream.destroy();
    await file.close();
  }

  if (issues.every(isUncommittedTailIssue)) {
    try {
      reduceWorkEvents(events);
    } catch (error) {
      if (error instanceof WorkReductionError) {
        const event = events.find((candidate) => candidate.id === error.eventId);
        issues.push({
          code: "invalid-transition",
          line: event === undefined ? 0 : (eventLines.get(event) ?? 0),
          message: error.message,
          eventId: error.eventId,
          sequence: error.sequence,
        });
      } else {
        throw error;
      }
    }
  }

  return { events, issues, lastSequence };
}

async function repairTornTailUnlocked(
  eventsPath: string,
): Promise<WorkTornTailRepairResult> {
  let file: FileHandle;
  try {
    file = await open(eventsPath, "r");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return { repaired: false, bytesRemoved: 0, lastSequence: 0 };
    }
    throw error;
  }

  let fileSize: number;
  let committedSize: number;
  let hasTornTail: boolean;
  try {
    const fileStat = await file.stat();
    fileSize = fileStat.size;
    if (fileSize === 0) {
      return { repaired: false, bytesRemoved: 0, lastSequence: 0 };
    }

    const terminalByte = new Uint8Array(1);
    await readFully(file, terminalByte, fileSize - 1);
    hasTornTail = terminalByte[0] !== 0x0a;
    committedSize = hasTornTail
      ? await committedPrefixSize(file, fileSize)
      : fileSize;
  } finally {
    await file.close();
  }

  const replay = await replayWorkLedger(eventsPath);
  if (!hasTornTail) {
    assertHealthyReplay(eventsPath, replay);
    return {
      repaired: false,
      bytesRemoved: 0,
      lastSequence: replay.lastSequence,
    };
  }

  if (
    replay.issues.length !== 1 ||
    !isUncommittedTailIssue(replay.issues[0]!)
  ) {
    throw new WorkLedgerCorruptionError(eventsPath, replay.issues);
  }

  const bytesRemoved = fileSize - committedSize;
  const writable = await open(eventsPath, "r+");
  try {
    await writable.truncate(committedSize);
    await writable.sync();
  } finally {
    await writable.close();
  }

  return {
    repaired: true,
    bytesRemoved,
    lastSequence: replay.lastSequence,
  };
}

function assertHealthyReplay(
  eventsPath: string,
  replay: WorkReplayResult,
): void {
  if (replay.issues.length > 0) {
    throw new WorkLedgerCorruptionError(eventsPath, replay.issues);
  }
}

function isUncommittedTailIssue(issue: WorkReplayIssue): boolean {
  return (
    issue.code === "malformed-record" &&
    issue.line === 0 &&
    issue.message === UNCOMMITTED_TAIL_MESSAGE
  );
}

async function appendWorkEvents(
  eventsPath: string,
  events: readonly WorkEvent[],
  syncWrites: boolean,
): Promise<void> {
  for (const event of events) assertWorkEventForWrite(event);
  const bytes = new TextEncoder().encode(
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  let file: FileHandle;
  let created = false;
  try {
    file = await open(eventsPath, "ax", 0o600);
    created = true;
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) throw error;
    file = await open(eventsPath, "a", 0o600);
  }

  try {
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await file.write(
        bytes,
        offset,
        bytes.length - offset,
        null,
      );
      if (bytesWritten === 0) {
        throw new Error(`Zero-byte write while appending ${eventsPath}`);
      }
      offset += bytesWritten;
    }
    if (syncWrites) await file.sync();
  } finally {
    await file.close();
  }

  if (syncWrites && created) {
    await syncDirectory(dirname(eventsPath));
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectoryChain(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  let cursor = resolve(directory);
  for (;;) {
    await syncDirectory(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

async function committedPrefixSize(
  file: FileHandle,
  fileSize: number,
): Promise<number> {
  let searchEnd = fileSize;
  const scanChunkSize = 8 * 1024;
  while (searchEnd > 0) {
    const chunkStart = Math.max(0, searchEnd - scanChunkSize);
    const chunk = new Uint8Array(searchEnd - chunkStart);
    await readFully(file, chunk, chunkStart);
    const boundary = chunk.lastIndexOf(0x0a);
    if (boundary >= 0) return chunkStart + boundary + 1;
    searchEnd = chunkStart;
  }
  return 0;
}

async function readFully(
  file: FileHandle,
  destination: Uint8Array,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < destination.length) {
    const { bytesRead } = await file.read(
      destination,
      offset,
      destination.length - offset,
      position + offset,
    );
    if (bytesRead === 0) {
      throw new Error("Unexpected end of work ledger while reading");
    }
    offset += bytesRead;
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof (value as { readonly then?: unknown }).then === "function"
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
