import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSortableId } from "../../src/core/identity";
import {
  WORK_EVENT_SCHEMA_VERSION,
  WorkEventValidationError,
  WorkLedger,
  WorkLedgerCorruptionError,
  WorkReductionError,
  assertWorkEventForWrite,
  fingerprintWork,
  normalizeWorkKey,
  normalizeWorkText,
  reduceWorkEvents,
  replayWorkLedger,
  scoreWorkQuery,
  type WorkEvent,
  type WorkEventInput,
  type WorkState,
  type WorkTransactionProposal,
} from "../../src/core/work";

const REPOSITORY_PATH = "D:\\github\\dispatch";
const REPOSITORY_KEY = "d:/github/dispatch";

let temporaryDirectory: string;
let eventsPath: string;
let clockTime: number;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "dispatch-work-ledger-"));
  eventsPath = join(temporaryDirectory, "intelligence", "work.jsonl");
  clockTime = Date.UTC(2026, 7, 1, 12, 0, 0, 0);
});

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("work ledger replay and reduction", () => {
  test("replays and reduces a missing ledger as empty state", async () => {
    expect(await replayWorkLedger(eventsPath)).toEqual({
      events: [],
      issues: [],
      lastSequence: 0,
    });

    const state = await ledger().read();
    expect(state.lastSequence).toBe(0);
    expect([...state.items.values()]).toEqual([]);
  });

  test("appends and reduces the complete work lifecycle", async () => {
    const workLedger = ledger();
    const wid = idAt(10);
    const sid = idAt(11);
    const iid = idAt(12);

    const created = await workLedger.append(
      createdInput(wid, "ledger-core", "Ledger core", "Track durable work"),
    );
    const attempt = await workLedger.append({
      src: "dsp",
      kind: "work.attempt.started",
      data: { wid, sid },
    });
    await workLedger.append({
      src: "user",
      kind: "work.insight.proposed",
      data: {
        wid,
        iid,
        kind: "decision",
        body: "Use one global ledger.",
        sessionId: sid,
      },
    });
    await workLedger.append({
      src: "user",
      kind: "work.status.changed",
      data: { wid, status: "review" },
    });
    await workLedger.append({
      src: "dsp",
      kind: "work.attempt.cancelled",
      data: { wid, sid },
    });

    expect(created.seq).toBe(1);
    expect(attempt.seq).toBe(2);
    const state = await workLedger.read();
    const item = state.items.get(wid);
    expect(state.lastSequence).toBe(5);
    expect(item).toEqual({
      wid,
      repositoryPath: REPOSITORY_PATH,
      repositoryKey: REPOSITORY_KEY,
      key: "ledger-core",
      title: "Ledger core",
      objective: "Track durable work",
      externalRef: null,
      priority: 2,
      fingerprint: fingerprintWork(
        REPOSITORY_KEY,
        "Ledger core",
        "Track durable work",
      ),
      status: "review",
      createdAt: "2026-08-01T12:00:00.000Z",
      updatedAt: "2026-08-01T12:00:00.004Z",
      attempts: [
        {
          sid,
          startedAt: "2026-08-01T12:00:00.001Z",
          cancelledAt: "2026-08-01T12:00:00.004Z",
          activatedWork: true,
        },
      ],
      insights: [
        {
          iid,
          kind: "decision",
          body: "Use one global ledger.",
          sessionId: sid,
          proposedAt: "2026-08-01T12:00:00.002Z",
        },
      ],
    });

    const contents = await readFile(eventsPath, "utf8");
    expect(contents.endsWith("\n")).toBe(true);
    expect(contents.trimEnd().split("\n")).toHaveLength(5);
  });

  test("reports duplicate IDs, duplicate sequences, gaps, and malformed records", async () => {
    const wid = idAt(20);
    const first = persistedEvent(createdInput(wid, "first"), 1, 101);
    const third = persistedEvent(
      createdInput(idAt(21), "third"),
      3,
      103,
    );
    const duplicate = { ...third };
    await mkdir(join(temporaryDirectory, "intelligence"), { recursive: true });
    await writeFile(
      eventsPath,
      [
        JSON.stringify(first),
        "{not-json",
        JSON.stringify(third),
        JSON.stringify(duplicate),
        "",
      ].join("\n"),
      "utf8",
    );

    const replay = await replayWorkLedger(eventsPath);
    const codes = replay.issues.map((issue) => issue.code);
    expect(codes).toContain("malformed-record");
    expect(codes).toContain("sequence-gap");
    expect(codes).toContain("duplicate-event-id");
    expect(codes).toContain("duplicate-sequence");
  });

  test("treats the final non-newline record as torn and blocks append", async () => {
    const first = persistedEvent(createdInput(idAt(30), "first"), 1, 201);
    const second = persistedEvent(createdInput(idAt(31), "second"), 2, 202);
    await mkdir(join(temporaryDirectory, "intelligence"), { recursive: true });
    const contents = `${JSON.stringify(first)}\n${JSON.stringify(second)}`;
    await writeFile(eventsPath, contents, "utf8");

    const replay = await replayWorkLedger(eventsPath);
    expect(replay.events.map((event) => event.seq)).toEqual([1]);
    expect(replay.issues).toEqual([
      expect.objectContaining({ code: "malformed-record", line: 0 }),
    ]);
    const workLedger = ledger();
    await expect(
      workLedger.append(createdInput(idAt(32), "blocked")),
    ).rejects.toBeInstanceOf(WorkLedgerCorruptionError);
    expect(await readFile(eventsPath, "utf8")).toBe(contents);

    expect(await workLedger.repairTornTail()).toEqual({
      repaired: true,
      bytesRemoved: new TextEncoder().encode(JSON.stringify(second)).byteLength,
      lastSequence: 1,
    });
    expect(await readFile(eventsPath, "utf8")).toBe(`${JSON.stringify(first)}\n`);

    const appended = await workLedger.append(
      createdInput(idAt(32), "repaired", "Repaired"),
    );
    expect(appended.seq).toBe(2);
    expect((await replayWorkLedger(eventsPath)).issues).toEqual([]);
    expect(await workLedger.repairTornTail()).toEqual({
      repaired: false,
      bytesRemoved: 0,
      lastSequence: 2,
    });
  });

  test("reports invalid domain history as corruption and blocks extension", async () => {
    const invalid = persistedEvent(
      {
        src: "user",
        kind: "work.status.changed",
        data: { wid: idAt(40), status: "active" },
      },
      1,
      301,
    );
    await mkdir(join(temporaryDirectory, "intelligence"), { recursive: true });
    await writeFile(eventsPath, `${JSON.stringify(invalid)}\n`, "utf8");

    const replay = await replayWorkLedger(eventsPath);
    expect(replay.issues).toEqual([
      expect.objectContaining({
        code: "invalid-transition",
        line: 1,
        eventId: invalid.id,
      }),
    ]);
    await expect(
      ledger().append(createdInput(idAt(41), "cannot-append")),
    ).rejects.toBeInstanceOf(WorkLedgerCorruptionError);
    const before = await readFile(eventsPath, "utf8");
    await expect(ledger().repairTornTail()).rejects.toBeInstanceOf(
      WorkLedgerCorruptionError,
    );
    expect(await readFile(eventsPath, "utf8")).toBe(before);
  });

  test("refuses torn-tail repair when the committed prefix is corrupt", async () => {
    const invalid = persistedEvent(
      {
        src: "user",
        kind: "work.status.changed",
        data: { wid: idAt(42), status: "active" },
      },
      1,
      302,
    );
    await mkdir(join(temporaryDirectory, "intelligence"), { recursive: true });
    const contents = `${JSON.stringify(invalid)}\n{uncommitted`;
    await writeFile(eventsPath, contents, "utf8");

    const replay = await replayWorkLedger(eventsPath);
    expect(replay.issues.map((issue) => issue.code)).toEqual([
      "malformed-record",
      "invalid-transition",
    ]);
    await expect(ledger().repairTornTail()).rejects.toBeInstanceOf(
      WorkLedgerCorruptionError,
    );
    expect(await readFile(eventsPath, "utf8")).toBe(contents);
  });
});

describe("work ledger transactions", () => {
  test("writes nothing when the callback throws or proposes an invalid transition", async () => {
    const workLedger = ledger();
    expect(
      workLedger.transact(() => {
        throw new Error("policy rejected");
      }),
    ).rejects.toThrow("policy rejected");
    expect(await pathExists(eventsPath)).toBe(false);

    await expect(
      workLedger.transact(() => ({
        inputs: [
          {
            src: "user",
            kind: "work.status.changed",
            data: { wid: idAt(50), status: "done" },
          },
        ],
        value: "unreachable",
      })),
    ).rejects.toBeInstanceOf(WorkReductionError);
    expect(await pathExists(eventsPath)).toBe(false);
  });

  test("rejects asynchronous callbacks before any write", async () => {
    const asyncCallback = (async () => ({
      inputs: [createdInput(idAt(51), "async")],
      value: true,
    })) as unknown as (
      state: WorkState,
    ) => WorkTransactionProposal<boolean>;

    await expect(ledger().transact(asyncCallback)).rejects.toThrow(
      "transaction callback must be synchronous",
    );
    expect(await pathExists(eventsPath)).toBe(false);
  });

  test("rejects multi-event transactions before writing any prefix", async () => {
    await expect(
      ledger().transact(() => ({
        inputs: [
          createdInput(idAt(52), "first-transaction-event", "First"),
          createdInput(idAt(53), "second-transaction-event", "Second"),
        ],
        value: true,
      })),
    ).rejects.toThrow("at most one event");
    expect(await pathExists(eventsPath)).toBe(false);
  });

  test("allocates unique global sequences across concurrent transactions", async () => {
    const ledgers = Array.from({ length: 20 }, () => ledger());
    const committed = await Promise.all(
      ledgers.map((workLedger, index) =>
        workLedger.transact(() => ({
          inputs: [
            createdInput(
              idAt(1_000 + index),
              `concurrent-${index}`,
              `Concurrent ${index}`,
            ),
          ],
          value: index,
        })),
      ),
    );

    expect(
      committed
        .flatMap((result) => result.events.map((event) => event.seq))
        .sort((left, right) => left - right),
    ).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    const replay = await replayWorkLedger(eventsPath);
    expect(replay.issues).toEqual([]);
    expect(replay.events).toHaveLength(20);
  });

  test("lets exactly one concurrent caller enforce a repository key", async () => {
    const ledgers = Array.from({ length: 16 }, () => ledger());
    const results = await Promise.all(
      ledgers.map((workLedger, index) =>
        workLedger.transact((state) => {
          const exists = [...state.items.values()].some(
            (item) =>
              item.repositoryKey === REPOSITORY_KEY && item.key === "same-key",
          );
          return {
            inputs: exists
              ? []
              : [
                  createdInput(
                    idAt(2_000 + index),
                    "same-key",
                    "Same key",
                  ),
                ],
            value: !exists,
          };
        }),
      ),
    );

    expect(results.filter((result) => result.value)).toHaveLength(1);
    expect(results.flatMap((result) => result.events)).toHaveLength(1);
    expect((await ledger().read()).items.size).toBe(1);
  });

  test("lets one concurrent caller enforce a single active attempt", async () => {
    const wid = idAt(3_000);
    await ledger().append(createdInput(wid, "one-attempt"));
    const ledgers = Array.from({ length: 12 }, () => ledger());
    const results = await Promise.all(
      ledgers.map((workLedger, index) =>
        workLedger.transact((state) => {
          const item = state.items.get(wid);
          if (item === undefined) throw new Error("missing test work item");
          const hasActiveAttempt = item.attempts.some(
            (attempt) => attempt.cancelledAt === null,
          );
          return {
            inputs: hasActiveAttempt
              ? []
              : [
                  {
                    src: "dsp",
                    kind: "work.attempt.started",
                    data: { wid, sid: idAt(3_100 + index) },
                  },
                ],
            value: !hasActiveAttempt,
          };
        }),
      ),
    );

    expect(results.filter((result) => result.value)).toHaveLength(1);
    expect((await ledger().read()).items.get(wid)?.attempts).toHaveLength(1);
  });

  test("restores planned only when cancelling the attempt that auto-activated work", async () => {
    const workLedger = ledger();
    const autoWid = idAt(3_200);
    const autoSid = idAt(3_201);
    await workLedger.append(
      createdInput(autoWid, "auto-activation", "Auto activation"),
    );
    await workLedger.append({
      src: "dsp",
      kind: "work.attempt.started",
      data: { wid: autoWid, sid: autoSid },
    });
    let autoItem = (await workLedger.read()).items.get(autoWid)!;
    expect(autoItem.status).toBe("active");
    expect(autoItem.attempts[0]?.activatedWork).toBe(true);
    await workLedger.append({
      src: "dsp",
      kind: "work.attempt.cancelled",
      data: { wid: autoWid, sid: autoSid },
    });
    autoItem = (await workLedger.read()).items.get(autoWid)!;
    expect(autoItem.status).toBe("planned");

    const activeWid = idAt(3_202);
    const activeSid = idAt(3_203);
    await workLedger.append(
      createdInput(activeWid, "explicit-active", "Explicit active"),
    );
    await workLedger.append({
      src: "user",
      kind: "work.status.changed",
      data: { wid: activeWid, status: "active" },
    });
    await workLedger.append({
      src: "dsp",
      kind: "work.attempt.started",
      data: { wid: activeWid, sid: activeSid },
    });
    expect(
      (await workLedger.read()).items.get(activeWid)?.attempts[0]?.activatedWork,
    ).toBe(false);
    await workLedger.append({
      src: "dsp",
      kind: "work.attempt.cancelled",
      data: { wid: activeWid, sid: activeSid },
    });
    expect((await workLedger.read()).items.get(activeWid)?.status).toBe("active");
  });

  test("does not restore planned while another attempt remains uncancelled", async () => {
    const workLedger = ledger();
    const wid = idAt(3_300);
    const activatingSid = idAt(3_301);
    const otherSid = idAt(3_302);
    await workLedger.append(createdInput(wid, "parallel-attempts"));
    await workLedger.append({
      src: "dsp",
      kind: "work.attempt.started",
      data: { wid, sid: activatingSid },
    });
    await workLedger.append({
      src: "dsp",
      kind: "work.attempt.started",
      data: { wid, sid: otherSid },
    });
    await workLedger.append({
      src: "dsp",
      kind: "work.attempt.cancelled",
      data: { wid, sid: activatingSid },
    });

    expect((await workLedger.read()).items.get(wid)?.status).toBe("active");
  });
});

describe("work normalization and validation", () => {
  test("normalizes keys and text conservatively and fingerprints equivalent text equally", () => {
    expect(normalizeWorkKey("  Ledger CORE_v1 ")).toBe("ledger-core_v1");
    expect(normalizeWorkKey("Auth/Refactor")).toBe("auth/refactor");
    expect(() => normalizeWorkKey("ledger:core")).toThrow(TypeError);
    expect(normalizeWorkText("  fullwidth： Ａ\r\n  B\tC  ")).toBe(
      "fullwidth: A B C",
    );

    const left = fingerprintWork(
      "d:/github/dispatch",
      "Ignored when objective exists",
      "Build\r\n the   intelligence layer",
    );
    const right = fingerprintWork(
      "d:/github/dispatch",
      "Different title",
      "Build the intelligence layer",
    );
    expect(left).toBe(right);
    expect(
      fingerprintWork("d:/github/other", "Different title", "Build the intelligence layer"),
    ).not.toBe(right);
  });

  test("returns transparent deterministic token overlap without equivalence claims", () => {
    const wid = idAt(4_000);
    const state = reduceWorkEvents([
      persistedEvent(createdInput(wid, "durable-ledger", "Durable work ledger"), 1, 401),
    ]);
    const item = state.items.get(wid)!;

    expect(scoreWorkQuery("ledger durable", item)).toEqual({
      score: 0.5,
      sharedTokens: ["durable", "ledger"],
    });
    expect(scoreWorkQuery("", item)).toEqual({ score: 0, sharedTokens: [] });
  });

  test("preserves opaque repository key bytes including internal spaces", () => {
    const repositoryKey = "d:/github/two  spaces/dispatch";
    const input = createdInput(idAt(4_100), "opaque-repository");
    const title = "Ledger core";
    const objective = "Track durable work: Ledger core";
    const event = persistedEvent(
      {
        ...input,
        data: {
          ...input.data,
          repositoryKey,
          fingerprint: fingerprintWork(repositoryKey, title, objective),
        },
      } as WorkEventInput,
      1,
      402,
    );

    expect(() => assertWorkEventForWrite(event)).not.toThrow();
    expect(
      fingerprintWork(repositoryKey, title, objective),
    ).not.toBe(fingerprintWork("d:/github/two spaces/dispatch", title, objective));
  });

  test("rejects noncanonical data, duplicate origins, duplicate attempts, and repeated cancellation", async () => {
    const wid = idAt(5_000);
    const sid = idAt(5_001);
    const workLedger = ledger();

    await expect(
      workLedger.append({
        ...createdInput(wid, "Bad Key"),
        data: {
          ...createdInput(wid, "bad-key").data,
          key: "Bad Key",
        },
      } as WorkEventInput),
    ).rejects.toBeInstanceOf(WorkEventValidationError);

    await workLedger.append(createdInput(wid, "valid"));
    await expect(
      workLedger.append(createdInput(wid, "duplicate-origin")),
    ).rejects.toBeInstanceOf(WorkReductionError);
    await workLedger.append({
      src: "dsp",
      kind: "work.attempt.started",
      data: { wid, sid },
    });
    await expect(
      workLedger.append({
        src: "dsp",
        kind: "work.attempt.started",
        data: { wid, sid },
      }),
    ).rejects.toBeInstanceOf(WorkReductionError);
    await workLedger.append({
      src: "dsp",
      kind: "work.attempt.cancelled",
      data: { wid, sid },
    });
    await expect(
      workLedger.append({
        src: "dsp",
        kind: "work.attempt.cancelled",
        data: { wid, sid },
      }),
    ).rejects.toBeInstanceOf(WorkReductionError);

    expect((await replayWorkLedger(eventsPath)).events).toHaveLength(3);
  });

  test("reserves repository-scoped keys and fingerprints in the reducer", async () => {
    const workLedger = ledger();
    await workLedger.append(
      createdInput(idAt(5_100), "reserved-key", "First", "First objective"),
    );

    try {
      await workLedger.append(
        createdInput(idAt(5_101), "reserved-key", "Second", "Second objective"),
      );
      throw new Error("expected duplicate work key rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkReductionError);
      expect((error as WorkReductionError).code).toBe("duplicate-work-key");
    }

    try {
      await workLedger.append(
        createdInput(idAt(5_102), "different-key", "Other title", "First objective"),
      );
      throw new Error("expected duplicate fingerprint rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkReductionError);
      expect((error as WorkReductionError).code).toBe(
        "duplicate-work-fingerprint",
      );
    }

    expect((await workLedger.read()).items.size).toBe(1);
  });

  test("rejects attempts outside planned/active and transitions out of superseded", async () => {
    const workLedger = ledger();
    const wid = idAt(5_200);
    await workLedger.append(createdInput(wid, "terminal-status"));
    await workLedger.append({
      src: "user",
      kind: "work.status.changed",
      data: { wid, status: "superseded" },
    });

    try {
      await workLedger.append({
        src: "dsp",
        kind: "work.attempt.started",
        data: { wid, sid: idAt(5_201) },
      });
      throw new Error("expected invalid attempt status rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkReductionError);
      expect((error as WorkReductionError).code).toBe("attempt-status-invalid");
    }

    try {
      await workLedger.append({
        src: "user",
        kind: "work.status.changed",
        data: { wid, status: "planned" },
      });
      throw new Error("expected terminal superseded status rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkReductionError);
      expect((error as WorkReductionError).code).toBe(
        "superseded-status-terminal",
      );
    }

    expect((await replayWorkLedger(eventsPath)).events).toHaveLength(2);
  });

  test("strictly rejects unknown envelope/data fields and invalid priorities", () => {
    const event = persistedEvent(createdInput(idAt(6_000), "strict"), 1, 501);
    expect(() => assertWorkEventForWrite(event)).not.toThrow();
    expect(() =>
      assertWorkEventForWrite({ ...event, ext: {} }),
    ).toThrow(WorkEventValidationError);
    expect(() =>
      assertWorkEventForWrite({
        ...event,
        data: { ...event.data, priority: 6 },
      }),
    ).toThrow(WorkEventValidationError);
    expect(() =>
      assertWorkEventForWrite({
        ...event,
        data: { ...event.data, unexpected: true },
      }),
    ).toThrow(WorkEventValidationError);
  });
});

function ledger(): WorkLedger {
  return new WorkLedger({
    eventsPath,
    machineId: "wkst-test-01",
    clock: () => new Date(clockTime++),
    syncWrites: false,
    lock: { timeoutMs: 5_000, pollIntervalMs: 1 },
  });
}

function createdInput(
  wid: string,
  key: string,
  title = "Ledger core",
  objective = `Track durable work: ${title}`,
): WorkEventInput {
  return {
    src: "user",
    kind: "work.created",
    data: {
      wid,
      repositoryPath: REPOSITORY_PATH,
      repositoryKey: REPOSITORY_KEY,
      key,
      title,
      objective,
      externalRef: null,
      priority: 2,
      fingerprint: fingerprintWork(REPOSITORY_KEY, title, objective),
    },
  };
}

function persistedEvent(
  input: WorkEventInput,
  sequence: number,
  idTimestamp: number,
): WorkEvent {
  const candidate: unknown = {
    v: WORK_EVENT_SCHEMA_VERSION,
    id: idAt(idTimestamp),
    mid: "wkst-test-01",
    seq: sequence,
    ts: new Date(Date.UTC(2026, 7, 1, 12, 0, 0, sequence)).toISOString(),
    src: input.src,
    kind: input.kind,
    data: input.data,
  };
  assertWorkEventForWrite(candidate);
  return candidate;
}

function idAt(timestamp: number): string {
  return createSortableId({
    timestamp,
    randomBytes: () => new Uint8Array(16),
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}
