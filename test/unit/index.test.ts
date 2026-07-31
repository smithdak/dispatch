import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionIndex, type SessionProjection } from "../../src/core/index";
import { createSortableId } from "../../src/core/identity";
import type { CanonicalEvent } from "../../src/core/ledger";

const directories: string[] = [];

function identifiers(): { sid: string; eventId: string } {
  return {
    sid: createSortableId({
      timestamp: 1_700_000_000_000,
      randomBytes: () => new Uint8Array(16).fill(1),
    }),
    eventId: createSortableId({
      timestamp: 1_700_000_000_001,
      randomBytes: () => new Uint8Array(16).fill(2),
    }),
  };
}

function fixture(): {
  root: string;
  index: SessionIndex;
  session: SessionProjection;
  event: CanonicalEvent;
} {
  const root = mkdtempSync(join(tmpdir(), "dispatch-index-"));
  directories.push(root);
  const ids = identifiers();
  const session: SessionProjection = {
    sid: ids.sid,
    mid: "test-machine",
    repositoryPath: join(root, "repo"),
    worktreePath: join(root, "worktree"),
    branch: "dispatch/test",
    baseBranch: "main",
    createdAt: "2023-11-14T22:13:20.000Z",
  };
  return {
    root,
    index: new SessionIndex(join(root, "index.sqlite")),
    session,
    event: {
      v: 1,
      id: ids.eventId,
      sid: ids.sid,
      mid: "test-machine",
      seq: 1,
      ts: "2023-11-14T22:13:20.001Z",
      src: "dsp",
      kind: "session.created",
      data: { repositoryPath: session.repositoryPath },
      ext: {},
    },
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  }
});

describe("derived session index", () => {
  test("supports session, cwd, and event projections", () => {
    const { index, session, event } = fixture();
    try {
      index.upsertSession(session);
      index.projectEvent(event);

      expect(index.getSession(session.sid)?.lastSeq).toBe(1);
      expect(
        index.resolveByPath(join(session.worktreePath, "src", "nested"))?.sid,
      ).toBe(session.sid);
      expect(index.listSessions()).toHaveLength(1);
      expect(index.countSessions()).toBe(1);
    } finally {
      index.close();
    }
  });

  test("rebuild replaces every projection from authoritative inputs", () => {
    const { index, session, event } = fixture();
    try {
      index.upsertSession(session);
      index.rebuild([{ session, events: [event] }]);

      expect(index.listSessions()).toHaveLength(1);
      expect(index.getSession(session.sid)?.lastSeq).toBe(1);
    } finally {
      index.close();
    }
  });

  test("projects mux receipts and preserves them across metadata upserts", () => {
    const { index, session, event } = fixture();
    const target = {
      version: 1,
      backend: "herdr",
      protocol: 18,
      workspaceId: "w-test",
      tabId: "w-test:t1",
      paneId: "w-test:p1",
      terminalId: "term_test",
      canonicalCwd: session.worktreePath,
    };
    const opened: CanonicalEvent = {
      ...event,
      id: createSortableId({
        timestamp: 1_700_000_000_002,
        randomBytes: () => new Uint8Array(16).fill(3),
      }),
      seq: 2,
      kind: "session.opened",
      data: { muxTarget: target, action: "created" },
    };

    try {
      index.upsertSession(session);
      index.projectEvent(event);
      index.projectEvent(opened);

      expect(JSON.parse(index.getSession(session.sid)?.muxTarget ?? "null"))
        .toEqual(target);

      index.upsertSession(session);
      expect(JSON.parse(index.getSession(session.sid)?.muxTarget ?? "null"))
        .toEqual(target);

      index.rebuild([{ session, events: [event, opened] }]);
      expect(JSON.parse(index.getSession(session.sid)?.muxTarget ?? "null"))
        .toEqual(target);
    } finally {
      index.close();
    }
  });

  test("rebuilds a mux target discovered only during terminal close", () => {
    const { index, session, event } = fixture();
    const target = {
      version: 1,
      backend: "herdr",
      protocol: 18,
      workspaceId: "w-close",
      tabId: "w-close:t1",
      paneId: "w-close:p1",
      terminalId: "term_close",
      canonicalCwd: session.worktreePath,
    };
    const closed: CanonicalEvent = {
      ...event,
      id: createSortableId({
        timestamp: 1_700_000_000_002,
        randomBytes: () => new Uint8Array(16).fill(3),
      }),
      seq: 2,
      kind: "session.closed",
      data: {
        reason: "terminal-closed",
        muxOutcome: "closed",
        muxTarget: target,
      },
    };

    try {
      index.rebuild([{ session, events: [event, closed] }]);
      expect(JSON.parse(index.getSession(session.sid)?.muxTarget ?? "null"))
        .toEqual(target);
      expect(index.getSession(session.sid)?.status).toBe("closed");
    } finally {
      index.close();
    }
  });

  test("resolves a reused path to the newest non-removed generation", () => {
    const { index, session, event } = fixture();
    const removed: CanonicalEvent = {
      ...event,
      id: createSortableId({
        timestamp: 1_700_000_000_002,
        randomBytes: () => new Uint8Array(16).fill(3),
      }),
      seq: 2,
      kind: "worktree.removed",
      data: { path: session.worktreePath },
    };
    const nextSid = createSortableId({
      timestamp: 1_700_000_000_003,
      randomBytes: () => new Uint8Array(16).fill(4),
    });
    const next: SessionProjection = {
      ...session,
      sid: nextSid,
      branch: "dispatch/reused",
      createdAt: "2023-11-14T22:13:20.003Z",
    };

    try {
      index.upsertSession(session);
      index.projectEvent(event);
      index.projectEvent(removed);
      index.upsertSession(next);

      expect(
        index.resolveByPath(join(session.worktreePath, "src"))?.sid,
      ).toBe(nextSid);
      expect(index.listSessions()).toHaveLength(2);
    } finally {
      index.close();
    }
  });
});
