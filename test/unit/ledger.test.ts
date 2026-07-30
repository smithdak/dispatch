import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { createSortableId } from "../../src/core/identity";
import {
  EVENT_SCHEMA_VERSION,
  EventValidationError,
  JsonlLedger,
  LedgerCorruptionError,
  LockTimeoutError,
  assertCanonicalEventForWrite,
  parseCanonicalEventForRead,
  recoverLastSequence,
  replayLedger,
  withExclusiveFileLock,
  type CanonicalEvent,
} from "../../src/core/ledger";

const SESSION_ID = createSortableId({
  timestamp: 1_000,
  randomBytes: () => new Uint8Array(16),
});

let temporaryDirectory: string;
let eventsPath: string;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "dispatch-ledger-"));
  eventsPath = join(temporaryDirectory, "sessions", SESSION_ID, "events.jsonl");
});

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("canonical event schema", () => {
  test("accepts exactly the canonical write envelope", () => {
    const event = eventAt(1, 1_001);

    expect(() => assertCanonicalEventForWrite(event)).not.toThrow();
  });

  test("rejects unknown envelope fields on write", () => {
    const event = {
      ...eventAt(1, 1_001),
      providerRequestId: "vendor-shaped",
    };

    expect(() => assertCanonicalEventForWrite(event)).toThrow(
      EventValidationError,
    );
  });

  test("preserves unknown envelope fields on tolerant read", () => {
    const event = {
      ...eventAt(1, 1_001),
      future: { trace: "kept" },
    };

    const parsed = parseCanonicalEventForRead(event);

    expect(parsed).toBe(event);
    expect(parsed.future).toEqual({ trace: "kept" });
  });

  test("rejects unknown sources, kinds, non-JSON data, and missing machine ID", () => {
    expect(() =>
      assertCanonicalEventForWrite({
        ...eventAt(1, 1_001),
        src: "terminal",
      }),
    ).toThrow(EventValidationError);

    expect(() =>
      assertCanonicalEventForWrite({
        ...eventAt(1, 1_001),
        kind: "tool.unknown",
      }),
    ).toThrow(EventValidationError);

    expect(() =>
      assertCanonicalEventForWrite({
        ...eventAt(1, 1_001),
        data: { invalid: Number.NaN },
      }),
    ).toThrow(EventValidationError);

    expect(() =>
      assertCanonicalEventForWrite({
        ...eventAt(1, 1_001),
        mid: " ",
      }),
    ).toThrow(EventValidationError);

    expect(() =>
      assertCanonicalEventForWrite({
        ...eventAt(1, 1_001),
        ext: { claude: "provider data must be namespaced as an object" },
      }),
    ).toThrow(EventValidationError);
  });
});

describe("JSONL ledger", () => {
  test("appends one canonical object per line and recovers sequence on reopen", async () => {
    let idTimestamp = 2_000;
    let wallTime = Date.UTC(2026, 6, 30, 15, 4, 5, 0);
    const options = {
      eventsPath,
      sessionId: SESSION_ID,
      machineId: "wkst-test-01",
      idFactory: () =>
        createSortableId({
          timestamp: idTimestamp++,
          randomBytes: () => new Uint8Array(16),
        }),
      clock: () => new Date(wallTime++),
    };
    const ledger = new JsonlLedger(options);

    const first = await ledger.append({
      src: "dsp",
      kind: "session.created",
      data: { repo: "/repo" },
    });
    const second = await new JsonlLedger(options).append({
      src: "hook",
      kind: "tool.called",
      data: { name: "Edit" },
      ext: { claude: { tool_use_id: "toolu_01" } },
    });

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(await recoverLastSequence(eventsPath, SESSION_ID)).toBe(2);

    const contents = await readFile(eventsPath, "utf8");
    const physicalLines = contents.trimEnd().split("\n");
    expect(physicalLines).toHaveLength(2);
    expect(physicalLines.every((line) => !line.includes("\n"))).toBe(true);

    const replay = await replayLedger(eventsPath, {
      expectedSessionId: SESSION_ID,
    });
    expect(replay.issues).toEqual([]);
    expect(replay.records).toHaveLength(2);
    expect(replay.records[1]?.ext).toEqual({
      claude: { tool_use_id: "toolu_01" },
    });
  });

  test("serializes concurrent appenders with unique monotonic sequences", async () => {
    const ledgers = Array.from(
      { length: 24 },
      () =>
        new JsonlLedger({
          eventsPath,
          sessionId: SESSION_ID,
          machineId: "wkst-test-01",
          syncWrites: false,
          lock: { timeoutMs: 5_000, pollIntervalMs: 1 },
        }),
    );

    const appended = await Promise.all(
      ledgers.map((ledger, index) =>
        ledger.append({
          src: "hook",
          kind: "tool.called",
          data: { index },
        }),
      ),
    );

    expect(appended.map((event) => event.seq).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 24 }, (_, index) => index + 1),
    );

    const replay = await replayLedger(eventsPath, {
      expectedSessionId: SESSION_ID,
    });
    expect(replay.issues).toEqual([]);
    expect(replay.records).toHaveLength(24);
    expect(replay.lastSequence).toBe(24);
  });

  test("reports malformed records, duplicate IDs, duplicate sequences, and gaps without mutation", async () => {
    const first = eventAt(1, 3_001);
    const third = eventAt(3, 3_003);
    const duplicate = {
      ...third,
      ts: "2026-07-30T15:04:06.000Z",
    };
    const contents = [
      JSON.stringify(first),
      "{not-json",
      JSON.stringify(third),
      JSON.stringify(duplicate),
      "",
    ].join("\n");
    await mkdir(join(temporaryDirectory, "sessions", SESSION_ID), {
      recursive: true,
    });
    await writeFile(eventsPath, contents, "utf8");
    const before = await readFile(eventsPath, "utf8");

    const replay = await replayLedger(eventsPath, {
      expectedSessionId: SESSION_ID,
    });

    expect(replay.issues.map((issue) => issue.code)).toContain(
      "malformed-record",
    );
    expect(replay.issues.map((issue) => issue.code)).toContain("sequence-gap");
    expect(replay.issues.map((issue) => issue.code)).toContain(
      "duplicate-event-id",
    );
    expect(replay.issues.map((issue) => issue.code)).toContain(
      "duplicate-sequence",
    );
    expect(await readFile(eventsPath, "utf8")).toBe(before);
  });

  test("refuses to append to a corrupt ledger", async () => {
    await mkdir(join(temporaryDirectory, "sessions", SESSION_ID), {
      recursive: true,
    });
    await writeFile(eventsPath, "{partial", "utf8");
    const before = await readFile(eventsPath, "utf8");
    const ledger = new JsonlLedger({
      eventsPath,
      sessionId: SESSION_ID,
      machineId: "wkst-test-01",
    });

    await expect(
      ledger.append({
        src: "user",
        kind: "outcome.recorded",
        data: { disposition: "abandoned" },
      }),
    ).rejects.toBeInstanceOf(LedgerCorruptionError);
    expect(await readFile(eventsPath, "utf8")).toBe(before);
  });

  test("treats a complete but non-terminated final object as a torn write", async () => {
    await mkdir(join(temporaryDirectory, "sessions", SESSION_ID), {
      recursive: true,
    });
    await writeFile(eventsPath, JSON.stringify(eventAt(1, 4_001)), "utf8");
    const ledger = new JsonlLedger({
      eventsPath,
      sessionId: SESSION_ID,
      machineId: "wkst-test-01",
    });

    await expect(
      ledger.append({
        src: "hook",
        kind: "tool.called",
        data: { name: "Read" },
      }),
    ).rejects.toBeInstanceOf(LedgerCorruptionError);

    const replay = await replayLedger(eventsPath, {
      expectedSessionId: SESSION_ID,
    });
    expect(replay.records).toEqual([]);
    expect(replay.issues).toEqual([
      expect.objectContaining({
        code: "malformed-record",
        line: 0,
      }),
    ]);
  });

  test("replays only newline-committed records before a torn tail", async () => {
    await mkdir(join(temporaryDirectory, "sessions", SESSION_ID), {
      recursive: true,
    });
    await writeFile(
      eventsPath,
      `${JSON.stringify(eventAt(1, 4_100))}\n${JSON.stringify(eventAt(2, 4_101))}`,
      "utf8",
    );

    const replay = await replayLedger(eventsPath, {
      expectedSessionId: SESSION_ID,
    });

    expect(replay.records.map((event) => event.seq)).toEqual([1]);
    expect(replay.lastSequence).toBe(1);
    expect(replay.issues.map((issue) => issue.code)).toEqual([
      "malformed-record",
    ]);
  });

  test("recovers from a final record larger than the bounded tail chunk", async () => {
    await mkdir(join(temporaryDirectory, "sessions", SESSION_ID), {
      recursive: true,
    });
    const large = {
      ...eventAt(1, 5_001),
      data: { payload: "x".repeat(20_000) },
    };
    await writeFile(eventsPath, `${JSON.stringify(large)}\n`, "utf8");
    const ledger = new JsonlLedger({
      eventsPath,
      sessionId: SESSION_ID,
      machineId: "wkst-test-01",
      syncWrites: false,
    });

    const appended = await ledger.append({
      src: "hook",
      kind: "tool.result",
      data: { ok: true },
    });

    expect(appended.seq).toBe(2);
  });

  test("keeps full historical validation out of the append hot path", async () => {
    await mkdir(join(temporaryDirectory, "sessions", SESSION_ID), {
      recursive: true,
    });
    await writeFile(
      eventsPath,
      `{malformed-earlier-record\n${JSON.stringify(eventAt(1, 6_001))}\n`,
      "utf8",
    );
    const ledger = new JsonlLedger({
      eventsPath,
      sessionId: SESSION_ID,
      machineId: "wkst-test-01",
      syncWrites: false,
    });

    const appended = await ledger.append({
      src: "hook",
      kind: "tool.result",
      data: { ok: true },
    });

    expect(appended.seq).toBe(2);
    const fullReplay = await replayLedger(eventsPath, {
      expectedSessionId: SESSION_ID,
    });
    expect(fullReplay.issues.map((issue) => issue.code)).toContain(
      "malformed-record",
    );
  });

  test("requires a machine ID before any append", () => {
    expect(
      () =>
        new JsonlLedger({
          eventsPath,
          sessionId: SESSION_ID,
          machineId: "",
        }),
    ).toThrow(TypeError);
  });

  test("times out rather than entering a held exclusive lock", async () => {
    let releaseHolder!: () => void;
    let announceHolder!: () => void;
    const holderEntered = new Promise<void>((resolve) => {
      announceHolder = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });

    const holder = withExclusiveFileLock(eventsPath, async () => {
      announceHolder();
      await hold;
    });
    await holderEntered;

    await expect(
      withExclusiveFileLock(
        eventsPath,
        async () => {
          throw new Error("must not enter");
        },
        { timeoutMs: 20, pollIntervalMs: 2 },
      ),
    ).rejects.toBeInstanceOf(LockTimeoutError);

    releaseHolder();
    await holder;
  });

  test("immediately reaps a same-host lock owned by a dead process", async () => {
    const child = Bun.spawn([process.execPath, "-e", ""], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const deadPid = child.pid;
    expect(await child.exited).toBe(0);

    const lockPath = `${eventsPath}.lock`;
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        token: "abandoned-owner",
        pid: deadPid,
        hostname: hostname(),
        createdAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );

    let entered = false;
    await withExclusiveFileLock(
      eventsPath,
      async () => {
        entered = true;
      },
      {
        timeoutMs: 500,
        pollIntervalMs: 1,
        staleAfterMs: 30_000,
      },
    );

    expect(entered).toBeTrue();
  });
});

function eventAt(sequence: number, idTimestamp: number): CanonicalEvent {
  return {
    v: EVENT_SCHEMA_VERSION,
    id: createSortableId({
      timestamp: idTimestamp,
      randomBytes: () => new Uint8Array(16),
    }),
    sid: SESSION_ID,
    mid: "wkst-test-01",
    seq: sequence,
    ts: "2026-07-30T15:04:05.123Z",
    src: "hook",
    kind: "tool.called",
    data: { name: "Edit" },
    ext: {},
  };
}
