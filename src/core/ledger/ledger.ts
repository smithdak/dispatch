import { open, type FileHandle } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createSortableId, isSortableId } from "../identity";
import {
  type CanonicalEvent,
  type EventKind,
  type EventSource,
  EVENT_SCHEMA_VERSION,
  type JsonObject,
  type ReadableEvent,
  assertCanonicalEventForWrite,
  parseCanonicalEventForRead,
} from "./schema";
import {
  type ExclusiveFileLockOptions,
  withExclusiveFileLock,
} from "./lock";

export type ReplayIssueCode =
  | "malformed-record"
  | "duplicate-event-id"
  | "duplicate-sequence"
  | "sequence-gap"
  | "sequence-regression"
  | "session-mismatch";

export interface ReplayIssue {
  readonly code: ReplayIssueCode;
  readonly line: number;
  readonly message: string;
  readonly eventId?: string;
  readonly sessionId?: string;
  readonly sequence?: number;
  readonly expectedSequence?: number;
}

export interface ReplayOptions {
  readonly expectedSessionId?: string;
}

export interface ReplayResult {
  readonly records: readonly ReadableEvent[];
  readonly issues: readonly ReplayIssue[];
  /**
   * Highest valid sequence observed for expectedSessionId. Without an
   * expected session, this is the highest sequence across all sessions.
   */
  readonly lastSequence: number;
}

export interface AppendEventInput {
  readonly src: EventSource;
  readonly kind: EventKind;
  readonly data: JsonObject;
  readonly ext?: JsonObject;
}

export interface JsonlLedgerOptions {
  readonly eventsPath: string;
  readonly sessionId: string;
  readonly machineId: string;
  readonly clock?: () => Date;
  readonly idFactory?: () => string;
  readonly syncWrites?: boolean;
  readonly lock?: ExclusiveFileLockOptions;
}

export class LedgerCorruptionError extends Error {
  readonly eventsPath: string;
  readonly issues: readonly ReplayIssue[];

  constructor(eventsPath: string, issues: readonly ReplayIssue[]) {
    super(
      `Ledger ${eventsPath} contains ${issues.length} replay issue${issues.length === 1 ? "" : "s"}; refusing to append`,
    );
    this.name = "LedgerCorruptionError";
    this.eventsPath = eventsPath;
    this.issues = issues;
  }
}

/**
 * Append-only, per-session JSONL ledger.
 *
 * Sequence recovery and append happen under the same cross-process lock, so
 * independently invoked hooks cannot allocate the same sequence.
 */
export class JsonlLedger {
  readonly eventsPath: string;
  readonly sessionId: string;
  readonly machineId: string;

  readonly #clock: () => Date;
  readonly #idFactory: () => string;
  readonly #syncWrites: boolean;
  readonly #lockOptions: ExclusiveFileLockOptions;

  constructor(options: JsonlLedgerOptions) {
    if (
      typeof options.eventsPath !== "string" ||
      options.eventsPath.trim().length === 0
    ) {
      throw new TypeError("eventsPath is required");
    }
    if (!isSortableId(options.sessionId)) {
      throw new TypeError("sessionId must be a canonical sortable ID");
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
    this.sessionId = options.sessionId;
    this.machineId = options.machineId;
    this.#clock = options.clock ?? (() => new Date());
    this.#idFactory = options.idFactory ?? (() => createSortableId());
    this.#syncWrites = options.syncWrites ?? true;
    this.#lockOptions = options.lock ?? {};
  }

  async append(input: AppendEventInput): Promise<CanonicalEvent> {
    return withExclusiveFileLock(
      this.eventsPath,
      async () => {
        const lastEvent = await readLastLedgerEvent(
          this.eventsPath,
          this.sessionId,
        );
        const lastSequence = lastEvent?.seq ?? 0;

        if (lastSequence >= Number.MAX_SAFE_INTEGER) {
          throw new RangeError("Ledger sequence exhausted the safe integer range");
        }

        const id = this.#createEventId(lastEvent);
        const timestamp = this.#clock();
        if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) {
          throw new TypeError("clock must return a valid Date");
        }

        const event: CanonicalEvent = {
          v: EVENT_SCHEMA_VERSION,
          id,
          sid: this.sessionId,
          mid: this.machineId,
          seq: lastSequence + 1,
          ts: timestamp.toISOString(),
          src: input.src,
          kind: input.kind,
          data: input.data,
          ext: input.ext ?? {},
        };

        assertCanonicalEventForWrite(event);
        await appendLine(this.eventsPath, event, this.#syncWrites);
        return event;
      },
      this.#lockOptions,
    );
  }

  #createEventId(lastEvent: ReadableEvent | undefined): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = this.#idFactory();
      if (!isSortableId(id)) {
        throw new TypeError("idFactory must return a canonical sortable ID");
      }
      if (id !== lastEvent?.id) {
        return id;
      }
    }

    throw new Error("Unable to allocate a unique event ID after 8 attempts");
  }
}

/**
 * Replays a ledger without modifying it. Valid records are returned even when
 * issues are present so diagnostics can report all detectable corruption in a
 * single pass.
 */
export async function replayLedger(
  eventsPath: string,
  options: ReplayOptions = {},
): Promise<ReplayResult> {
  if (
    options.expectedSessionId !== undefined &&
    !isSortableId(options.expectedSessionId)
  ) {
    throw new TypeError("expectedSessionId must be a canonical sortable ID");
  }

  let file;
  try {
    file = await open(eventsPath, "r");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return { records: [], issues: [], lastSequence: 0 };
    }
    throw error;
  }

  const records: ReadableEvent[] = [];
  const issues: ReplayIssue[] = [];
  const seenIds = new Set<string>();
  const seenSequences = new Map<string, Set<number>>();
  const nextSequences = new Map<string, number>();
  const maxSequences = new Map<string, number>();
  const fileStat = await file.stat();
  let committedSize = fileStat.size;
  if (fileStat.size > 0) {
    const terminalByte = new Uint8Array(1);
    await readFully(file, terminalByte, fileStat.size - 1);
    if (terminalByte[0] !== 0x0a) {
      issues.push({
        code: "malformed-record",
        line: 0,
        message:
          "Final ledger record is not newline-terminated and is not committed",
      });
      committedSize = await committedPrefixSize(file, fileStat.size);
    }
  }

  if (committedSize === 0) {
    await file.close();
    return { records, issues, lastSequence: 0 };
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
          message: "Ledger line is empty",
        });
        continue;
      }

      let record: ReadableEvent;
      try {
        record = parseCanonicalEventForRead(JSON.parse(line));
      } catch (error) {
        issues.push({
          code: "malformed-record",
          line: lineNumber,
          message: errorMessage(error),
        });
        continue;
      }

      records.push(record);

      if (
        options.expectedSessionId !== undefined &&
        record.sid !== options.expectedSessionId
      ) {
        issues.push({
          code: "session-mismatch",
          line: lineNumber,
          message: `Expected session ${options.expectedSessionId}, received ${record.sid}`,
          eventId: record.id,
          sessionId: record.sid,
          sequence: record.seq,
        });
      }

      if (seenIds.has(record.id)) {
        issues.push({
          code: "duplicate-event-id",
          line: lineNumber,
          message: `Event ID ${record.id} was already observed`,
          eventId: record.id,
          sessionId: record.sid,
          sequence: record.seq,
        });
      } else {
        seenIds.add(record.id);
      }

      const sessionSequences =
        seenSequences.get(record.sid) ?? new Set<number>();
      const expectedSequence = nextSequences.get(record.sid) ?? 1;

      if (sessionSequences.has(record.seq)) {
        issues.push({
          code: "duplicate-sequence",
          line: lineNumber,
          message: `Sequence ${record.seq} was already observed for session ${record.sid}`,
          eventId: record.id,
          sessionId: record.sid,
          sequence: record.seq,
          expectedSequence,
        });
      } else if (record.seq > expectedSequence) {
        issues.push({
          code: "sequence-gap",
          line: lineNumber,
          message: `Expected sequence ${expectedSequence}, received ${record.seq}`,
          eventId: record.id,
          sessionId: record.sid,
          sequence: record.seq,
          expectedSequence,
        });
      } else if (record.seq < expectedSequence) {
        issues.push({
          code: "sequence-regression",
          line: lineNumber,
          message: `Sequence regressed from ${expectedSequence} to ${record.seq}`,
          eventId: record.id,
          sessionId: record.sid,
          sequence: record.seq,
          expectedSequence,
        });
      }

      sessionSequences.add(record.seq);
      seenSequences.set(record.sid, sessionSequences);
      nextSequences.set(
        record.sid,
        Math.max(expectedSequence, record.seq + 1),
      );
      maxSequences.set(
        record.sid,
        Math.max(maxSequences.get(record.sid) ?? 0, record.seq),
      );
    }
  } finally {
    lines.close();
    stream.destroy();
    await file.close();
  }

  const lastSequence =
    options.expectedSessionId === undefined
      ? Math.max(0, ...maxSequences.values())
      : (maxSequences.get(options.expectedSessionId) ?? 0);

  return { records, issues, lastSequence };
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
    if (boundary >= 0) {
      return chunkStart + boundary + 1;
    }
    searchEnd = chunkStart;
  }

  return 0;
}

export async function recoverLastSequence(
  eventsPath: string,
  expectedSessionId?: string,
): Promise<number> {
  const replay = await replayLedger(
    eventsPath,
    expectedSessionId === undefined ? {} : { expectedSessionId },
  );
  if (replay.issues.length > 0) {
    throw new LedgerCorruptionError(eventsPath, replay.issues);
  }
  return replay.lastSequence;
}

/**
 * Reads only the final physical record. The scan moves backward in bounded
 * chunks until it finds the preceding newline, so append cost is independent
 * of ledger length and grows only with the final record's size.
 */
export async function readLastLedgerEvent(
  eventsPath: string,
  expectedSessionId: string,
): Promise<ReadableEvent | undefined> {
  let file: FileHandle;
  try {
    file = await open(eventsPath, "r");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }

  try {
    const fileStat = await file.stat();
    if (fileStat.size === 0) {
      return undefined;
    }

    const terminalByte = new Uint8Array(1);
    await readFully(file, terminalByte, fileStat.size - 1);
    if (terminalByte[0] !== 0x0a) {
      throw tailCorruption(
        eventsPath,
        "Last ledger record is not newline-terminated and may be torn",
      );
    }

    const lineEnd = fileStat.size - 1;
    let searchEnd = lineEnd;
    let lineStart = 0;
    const scanChunkSize = 8 * 1024;

    while (searchEnd > 0) {
      const chunkStart = Math.max(0, searchEnd - scanChunkSize);
      const chunk = new Uint8Array(searchEnd - chunkStart);
      await readFully(file, chunk, chunkStart);
      const boundary = chunk.lastIndexOf(0x0a);

      if (boundary >= 0) {
        lineStart = chunkStart + boundary + 1;
        break;
      }

      searchEnd = chunkStart;
    }

    let lineLength = lineEnd - lineStart;
    if (lineLength <= 0) {
      throw tailCorruption(eventsPath, "Last ledger record is empty");
    }

    const lineBytes = new Uint8Array(lineLength);
    await readFully(file, lineBytes, lineStart);
    if (lineBytes[lineBytes.length - 1] === 0x0d) {
      lineLength -= 1;
    }
    if (lineLength <= 0) {
      throw tailCorruption(eventsPath, "Last ledger record is empty");
    }

    let event: ReadableEvent;
    try {
      event = parseCanonicalEventForRead(
        JSON.parse(new TextDecoder().decode(lineBytes.subarray(0, lineLength))),
      );
    } catch (error) {
      throw tailCorruption(
        eventsPath,
        `Last ledger record is malformed: ${errorMessage(error)}`,
      );
    }

    if (event.sid !== expectedSessionId) {
      throw new LedgerCorruptionError(eventsPath, [
        {
          code: "session-mismatch",
          line: 0,
          message: `Last ledger record belongs to session ${event.sid}, expected ${expectedSessionId}`,
          eventId: event.id,
          sessionId: event.sid,
          sequence: event.seq,
        },
      ]);
    }

    return event;
  } finally {
    await file.close();
  }
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
      throw new Error("Unexpected end of ledger while reading its tail");
    }
    offset += bytesRead;
  }
}

function tailCorruption(
  eventsPath: string,
  message: string,
): LedgerCorruptionError {
  return new LedgerCorruptionError(eventsPath, [
    {
      code: "malformed-record",
      // Tail recovery deliberately avoids an O(n) line-count scan. Line zero
      // identifies the terminal physical record when its ordinal is unknown.
      line: 0,
      message,
    },
  ]);
}

async function appendLine(
  eventsPath: string,
  event: CanonicalEvent,
  syncWrite: boolean,
): Promise<void> {
  assertCanonicalEventForWrite(event);

  // JSON.stringify escapes embedded newlines; the only physical newline is
  // the record delimiter appended here.
  const bytes = new TextEncoder().encode(`${JSON.stringify(event)}\n`);
  const file = await open(eventsPath, "a", 0o600);

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

    if (syncWrite) {
      await file.sync();
    }
  } finally {
    await file.close();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
