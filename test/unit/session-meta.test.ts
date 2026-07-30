import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readAllSessionMeta,
  readSessionMeta,
  sessionEventsPath,
  writeSessionMeta,
  type SessionMeta,
} from "../../src/application/session-meta";
import { createSortableId } from "../../src/core/identity";
import { JsonlLedger } from "../../src/core/ledger";
import { resolveDispatchPaths } from "../../src/core/paths";

const directories: string[] = [];

function fixture(): {
  root: string;
  paths: ReturnType<typeof resolveDispatchPaths>;
  meta: SessionMeta;
} {
  const root = mkdtempSync(join(tmpdir(), "dispatch-meta-"));
  directories.push(root);
  const paths = resolveDispatchPaths({ HOME: root, DISPATCH_HOME: root }, "linux");
  const sid = createSortableId({ timestamp: 1_700_000_000_000 });
  return {
    root,
    paths,
    meta: {
      v: 1,
      sid,
      mid: "test-machine",
      repositoryPath: join(root, "repo"),
      worktreePath: join(root, "worktree"),
      branch: `dispatch/test-${sid}`,
      baseBranch: "main",
      baseCommit: "a".repeat(40),
      createdAt: "2023-11-14T22:13:20.000Z",
    },
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("immutable session metadata", () => {
  test("round-trips and enumerates metadata backed by a ledger origin", async () => {
    const { paths, meta } = fixture();
    writeSessionMeta(paths, meta);
    await new JsonlLedger({
      eventsPath: sessionEventsPath(paths, meta.sid),
      sessionId: meta.sid,
      machineId: meta.mid,
    }).append({
      src: "dsp",
      kind: "session.created",
      data: {
        repositoryPath: meta.repositoryPath,
        worktreePath: meta.worktreePath,
        branch: meta.branch,
        baseBranch: meta.baseBranch,
        baseCommit: meta.baseCommit,
        createdAt: meta.createdAt,
      },
    });

    expect(readSessionMeta(paths, meta.sid)).toEqual(meta);
    expect(readAllSessionMeta(paths)).toEqual([meta]);
  });

  test("refuses to replace immutable metadata", () => {
    const { paths, meta } = fixture();
    writeSessionMeta(paths, meta);

    expect(() => writeSessionMeta(paths, meta)).toThrow(
      "Session metadata already exists",
    );
  });

  test("ignores a pre-origin SID directory with no committed ledger bytes", () => {
    const { paths, meta } = fixture();
    const directory = join(paths.sessionsDir, meta.sid);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "events.jsonl"), "");

    expect(readAllSessionMeta(paths)).toEqual([]);
  });
});
