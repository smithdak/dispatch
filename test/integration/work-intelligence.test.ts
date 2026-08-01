import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  briefRepositoryWork,
  createWorkItem,
  getWorkItemBrief,
  listWorkItems,
  proposeWorkInsight,
  setWorkStatus,
  startWorkSession,
} from "../../src/application/work-items";
import { appendSessionEvent } from "../../src/application/ledger-service";
import {
  createSession,
  mergeSession,
  removeSession,
} from "../../src/application/sessions";
import { runCli } from "../../src/cli/run";
import { loadConfig } from "../../src/core/config";
import { createSortableId } from "../../src/core/identity";
import {
  ensureMachineId,
  resolveDispatchPaths,
} from "../../src/core/paths";
import { WorkLedger } from "../../src/core/work";

const roots: string[] = [];

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: processEnv(),
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
  return stdout.trim();
}

function processEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

async function fixture(): Promise<{
  readonly root: string;
  readonly repositoryPath: string;
  readonly env: Record<string, string>;
  readonly paths: ReturnType<typeof resolveDispatchPaths>;
}> {
  const root = await mkdtemp(join(tmpdir(), "dispatch-work-intelligence-"));
  roots.push(root);
  const repositoryPath = join(root, "repository");
  await mkdir(repositoryPath, { recursive: true });
  await git(root, ["init", "--initial-branch=main", "--", repositoryPath]);
  await git(repositoryPath, ["config", "user.name", "Dispatch Tests"]);
  await git(repositoryPath, [
    "config",
    "user.email",
    "dispatch-tests@example.invalid",
  ]);
  await git(repositoryPath, ["config", "core.autocrlf", "false"]);
  await writeFile(join(repositoryPath, "README.md"), "# Work intelligence\n");
  await git(repositoryPath, ["add", "--", "README.md"]);
  await git(repositoryPath, ["commit", "-m", "initial"]);
  const env = {
    ...processEnv(),
    HOME: root,
    USERPROFILE: root,
    DISPATCH_HOME: join(root, "state"),
    DISPATCH_WORKTREE_ROOT: join(root, "worktrees"),
    DISPATCH_BRANCH_PREFIX: "dispatch-intelligence/",
  };
  return {
    root,
    repositoryPath,
    env,
    paths: resolveDispatchPaths(env),
  };
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});

describe("work intelligence", () => {
  test("creates one canonical work identity and rejects conflicting duplicates", async () => {
    const value = await fixture();
    const options = {
      repositoryPath: value.repositoryPath,
      key: "auth/session-hardening",
      title: "Harden session authentication",
      objective: "Prevent stale authentication sessions",
      priority: 1,
      paths: value.paths,
      env: value.env,
    } as const;

    const created = await createWorkItem(options);
    const retried = await createWorkItem(options);

    expect(created.created).toBeTrue();
    expect(retried).toEqual({ created: false, item: created.item });
    expect(created.item).toMatchObject({
      key: "auth/session-hardening",
      status: "planned",
      priority: 1,
      attempts: [],
      insights: [],
    });

    await expect(
      createWorkItem({
        ...options,
        title: "Replace the authentication design",
      }),
    ).rejects.toMatchObject({ code: "work.key_conflict" });
    await expect(
      createWorkItem({ ...options, key: "auth/duplicate-key" }),
    ).rejects.toMatchObject({ code: "work.duplicate" });

    expect(await listWorkItems({ paths: value.paths, env: value.env })).toEqual([
      created.item,
    ]);
  });

  test("keeps superseded identities reserved against duplicate recreation", async () => {
    const value = await fixture();
    const created = await createWorkItem({
      repositoryPath: value.repositoryPath,
      key: "intelligence/original-identity",
      title: "Retain superseded duplicate identity",
      objective: "Prevent resurrection under a different key",
      paths: value.paths,
      env: value.env,
    });
    await setWorkStatus(created.item.wid, "superseded", {
      paths: value.paths,
      env: value.env,
    });

    await expect(
      createWorkItem({
        repositoryPath: value.repositoryPath,
        key: "intelligence/recreated-identity",
        title: "Retain superseded duplicate identity",
        objective: "Prevent resurrection under a different key",
        paths: value.paths,
        env: value.env,
      }),
    ).rejects.toMatchObject({ code: "work.duplicate" });
  });

  test("atomically admits one active attempt and briefs from session evidence", async () => {
    const value = await fixture();
    const created = await createWorkItem({
      repositoryPath: value.repositoryPath,
      key: "intelligence/atomic-start",
      title: "Build atomic work starts",
      objective: "Prevent concurrent duplicate execution",
      paths: value.paths,
      env: value.env,
    });

    const starts = await Promise.allSettled([
      startWorkSession(created.item.wid, {
        paths: value.paths,
        env: value.env,
      }),
      startWorkSession(created.item.wid, {
        paths: value.paths,
        env: value.env,
      }),
    ]);
    const successes = starts.filter((result) => result.status === "fulfilled");
    const failures = starts.filter((result) => result.status === "rejected");
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect((failures[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "work.attempt_active",
    });

    const started = (successes[0] as PromiseFulfilledResult<
      Awaited<ReturnType<typeof startWorkSession>>
    >).value;
    expect(started.workId).toBe(created.item.wid);
    const brief = await getWorkItemBrief(created.item.wid, {
      paths: value.paths,
      env: value.env,
    });
    expect(brief.item.status).toBe("active");
    expect(brief.attempts).toHaveLength(1);
    expect(brief.attempts[0]).toMatchObject({
      sid: started.meta.sid,
      state: "active",
    });

    const linkedCreate = await createWorkItem({
      repositoryPath: started.meta.worktreePath,
      key: "intelligence/atomic-start",
      title: "Build atomic work starts",
      objective: "Prevent concurrent duplicate execution",
      paths: value.paths,
      env: value.env,
    });
    expect(linkedCreate).toEqual({ created: false, item: brief.item });
    const linkedBrief = await briefRepositoryWork(undefined, {
      repositoryPath: started.meta.worktreePath,
      paths: value.paths,
      env: value.env,
    });
    expect(linkedBrief.repositoryPath).toBe(value.repositoryPath);
    expect(linkedBrief.roadmap.active[0]?.item.wid).toBe(created.item.wid);

    const noted = await proposeWorkInsight(
      created.item.wid,
      "learning",
      "Reserve identity before creating external state.",
      {
        sessionId: started.meta.sid,
        paths: value.paths,
        env: value.env,
      },
    );
    expect(noted.insights).toHaveLength(1);
    expect(noted.insights[0]).toMatchObject({
      kind: "learning",
      sessionId: started.meta.sid,
    });

    await expect(
      setWorkStatus(created.item.wid, "planned", {
        paths: value.paths,
        env: value.env,
      }),
    ).rejects.toMatchObject({ code: "work.attempt_active" });

    await setWorkStatus(created.item.wid, "blocked", {
      paths: value.paths,
      env: value.env,
    });
    const repositoryBrief = await briefRepositoryWork(
      "atomic duplicate execution",
      {
        repositoryPath: value.repositoryPath,
        paths: value.paths,
        env: value.env,
      },
    );
    expect(repositoryBrief.roadmap.blocked).toHaveLength(1);
    expect(repositoryBrief.matches[0]).toMatchObject({
      item: { wid: created.item.wid },
    });
    expect(repositoryBrief.matches[0]!.score).toBeGreaterThan(0);
  });

  test("cancels a reservation when session creation fails before durable origin", async () => {
    const value = await fixture();
    const created = await createWorkItem({
      repositoryPath: value.repositoryPath,
      key: "intelligence/start-recovery",
      title: "Recover failed work starts",
      paths: value.paths,
      env: value.env,
    });
    const occupied = join(value.root, "occupied");
    await mkdir(occupied);

    await expect(
      startWorkSession(created.item.wid, {
        repositoryPath: value.repositoryPath,
        worktreePath: occupied,
        paths: value.paths,
        env: value.env,
      }),
    ).rejects.toBeDefined();

    const brief = await getWorkItemBrief(created.item.wid, {
      paths: value.paths,
      env: value.env,
    });
    expect(brief.item.status).toBe("planned");
    expect(brief.attempts).toHaveLength(1);
    expect(brief.attempts[0]?.state).toBe("cancelled");

    const retry = await startWorkSession(created.item.wid, {
      repositoryPath: value.repositoryPath,
      paths: value.paths,
      env: value.env,
    });
    expect(retry.meta.sid).not.toBe(brief.attempts[0]?.sid);
  });

  test("skips a standalone session ID collision before reserving work", async () => {
    const value = await fixture();
    const collidingSid = createSortableId();
    const replacementSid = createSortableId();
    await createSession({
      sessionId: collidingSid,
      name: "Standalone collision owner",
      repositoryPath: value.repositoryPath,
      paths: value.paths,
      env: value.env,
    });
    const created = await createWorkItem({
      repositoryPath: value.repositoryPath,
      key: "intelligence/session-id-collision",
      title: "Retry session identity allocation safely",
      paths: value.paths,
      env: value.env,
    });
    const candidates = [collidingSid, replacementSid];

    const started = await startWorkSession(created.item.wid, {
      paths: value.paths,
      env: value.env,
      sessionIdFactory: () => candidates.shift()!,
    });
    expect(started.meta.sid).toBe(replacementSid);
    const brief = await getWorkItemBrief(created.item.wid, {
      paths: value.paths,
      env: value.env,
    });
    expect(brief.attempts).toHaveLength(1);
    expect(brief.attempts[0]?.sid).toBe(replacementSid);
  });

  test("rejects starting work in a different repository before reserving an attempt", async () => {
    const value = await fixture();
    const otherRepository = join(value.root, "other-repository");
    await mkdir(otherRepository, { recursive: true });
    await git(value.root, [
      "init",
      "--initial-branch=main",
      "--",
      otherRepository,
    ]);
    await git(otherRepository, ["config", "user.name", "Dispatch Tests"]);
    await git(otherRepository, [
      "config",
      "user.email",
      "dispatch-tests@example.invalid",
    ]);
    await git(otherRepository, ["config", "core.autocrlf", "false"]);
    await writeFile(join(otherRepository, "README.md"), "# Other repository\n");
    await git(otherRepository, ["add", "--", "README.md"]);
    await git(otherRepository, ["commit", "-m", "initial"]);

    const created = await createWorkItem({
      repositoryPath: value.repositoryPath,
      key: "intelligence/repository-boundary",
      title: "Keep attempts in their owning repository",
      paths: value.paths,
      env: value.env,
    });
    await expect(
      startWorkSession(created.item.wid, {
        repositoryPath: otherRepository,
        paths: value.paths,
        env: value.env,
      }),
    ).rejects.toMatchObject({ code: "work.repository_mismatch" });

    const brief = await getWorkItemBrief(created.item.wid, {
      paths: value.paths,
      env: value.env,
    });
    expect(brief.item.status).toBe("planned");
    expect(brief.attempts).toHaveLength(0);
  });

  test("treats a dirty forced discard as terminal evidence and permits retry", async () => {
    const value = await fixture();
    const created = await createWorkItem({
      repositoryPath: value.repositoryPath,
      key: "intelligence/discard-retry",
      title: "Retry deliberately discarded work",
      paths: value.paths,
      env: value.env,
    });
    const first = await startWorkSession(created.item.wid, {
      paths: value.paths,
      env: value.env,
    });
    await writeFile(join(first.meta.worktreePath, "dirty.txt"), "discard me\n");

    await removeSession(first.meta.sid, true, {
      paths: value.paths,
      env: value.env,
    });
    const discarded = await getWorkItemBrief(created.item.wid, {
      paths: value.paths,
      env: value.env,
    });
    expect(discarded.attempts[0]).toMatchObject({
      sid: first.meta.sid,
      state: "discarded",
      corroborated: true,
    });

    const retry = await startWorkSession(created.item.wid, {
      paths: value.paths,
      env: value.env,
    });
    expect(retry.meta.sid).not.toBe(first.meta.sid);
  });

  test("keeps a clean removal without an outcome unresolved", async () => {
    const value = await fixture();
    const created = await createWorkItem({
      repositoryPath: value.repositoryPath,
      key: "intelligence/unresolved-removal",
      title: "Do not erase unresolved work by removing its worktree",
      paths: value.paths,
      env: value.env,
    });
    const first = await startWorkSession(created.item.wid, {
      paths: value.paths,
      env: value.env,
    });
    await removeSession(first.meta.sid, false, {
      paths: value.paths,
      env: value.env,
    });

    const brief = await getWorkItemBrief(created.item.wid, {
      paths: value.paths,
      env: value.env,
    });
    expect(brief.attempts[0]).toMatchObject({
      state: "removed",
      corroborated: false,
    });
    expect(brief.evidence.unresolved).toBe(1);
    await expect(
      startWorkSession(created.item.wid, {
        paths: value.paths,
        env: value.env,
      }),
    ).rejects.toMatchObject({ code: "work.attempt_active" });
  });

  test("never commits terminal roadmap state beside a concurrently started attempt", async () => {
    const value = await fixture();
    const created = await createWorkItem({
      repositoryPath: value.repositoryPath,
      key: "intelligence/status-race",
      title: "Serialize work completion with attempt starts",
      paths: value.paths,
      env: value.env,
    });

    const results = await Promise.allSettled([
      startWorkSession(created.item.wid, {
        paths: value.paths,
        env: value.env,
      }),
      setWorkStatus(created.item.wid, "done", {
        paths: value.paths,
        env: value.env,
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

    const brief = await getWorkItemBrief(created.item.wid, {
      paths: value.paths,
      env: value.env,
    });
    expect(
      brief.item.status === "done" && brief.evidence.unresolved > 0,
    ).toBeFalse();
  });

  test("rejects foreign session evidence joined only by a reserved session ID", async () => {
    const value = await fixture();
    const owner = await createWorkItem({
      repositoryPath: value.repositoryPath,
      key: "intelligence/evidence-owner",
      title: "Authenticate work evidence ownership",
      paths: value.paths,
      env: value.env,
    });
    const foreign = await createWorkItem({
      repositoryPath: value.repositoryPath,
      key: "intelligence/evidence-foreign",
      title: "Represent a foreign work identity",
      paths: value.paths,
      env: value.env,
    });
    const sid = createSortableId();
    const workLedger = new WorkLedger({
      eventsPath: value.paths.workEventsPath,
      machineId: ensureMachineId(value.paths),
      syncWrites: true,
    });
    await workLedger.append({
      src: "dsp",
      kind: "work.attempt.started",
      data: { wid: owner.item.wid, sid },
    });
    await createSession({
      sessionId: sid,
      workId: foreign.item.wid,
      name: "Foreign Evidence",
      repositoryPath: value.repositoryPath,
      paths: value.paths,
      env: value.env,
    });

    const brief = await getWorkItemBrief(owner.item.wid, {
      paths: value.paths,
      env: value.env,
    });
    expect(brief.attempts[0]).toMatchObject({
      sid,
      state: "inconsistent",
      corroborated: false,
    });
    await expect(
      startWorkSession(owner.item.wid, {
        paths: value.paths,
        env: value.env,
      }),
    ).rejects.toMatchObject({ code: "work.attempt_active" });
  });

  test("fails closed when terminal session evidence conflicts", async () => {
    const value = await fixture();
    const created = await createWorkItem({
      repositoryPath: value.repositoryPath,
      key: "intelligence/conflicting-evidence",
      title: "Reject contradictory terminal evidence",
      paths: value.paths,
      env: value.env,
    });
    const started = await startWorkSession(created.item.wid, {
      paths: value.paths,
      env: value.env,
    });
    const config = loadConfig(
      value.paths,
      started.meta.repositoryPath,
      value.env,
    );
    await appendSessionEvent(value.paths, config, started.meta, {
      src: "dsp",
      kind: "git.merged",
      data: {},
    });
    await appendSessionEvent(value.paths, config, started.meta, {
      src: "dsp",
      kind: "git.discarded",
      data: {},
    });

    const brief = await getWorkItemBrief(created.item.wid, {
      paths: value.paths,
      env: value.env,
    });
    expect(brief.attempts[0]).toMatchObject({
      state: "inconsistent",
      corroborated: false,
    });
    await appendSessionEvent(value.paths, config, started.meta, {
      src: "user",
      kind: "outcome.recorded",
      data: { disposition: "merged" },
    });
    expect(
      (await getWorkItemBrief(created.item.wid, {
        paths: value.paths,
        env: value.env,
      })).attempts[0],
    ).toMatchObject({ state: "inconsistent", corroborated: false });
    await expect(
      startWorkSession(created.item.wid, {
        paths: value.paths,
        env: value.env,
      }),
    ).rejects.toMatchObject({ code: "work.attempt_active" });

    const abandoned = await createWorkItem({
      repositoryPath: value.repositoryPath,
      key: "intelligence/merge-abandon-conflict",
      title: "Reject merge and abandon evidence together",
      paths: value.paths,
      env: value.env,
    });
    const abandonedAttempt = await startWorkSession(abandoned.item.wid, {
      paths: value.paths,
      env: value.env,
    });
    await appendSessionEvent(value.paths, config, abandonedAttempt.meta, {
      src: "dsp",
      kind: "git.merged",
      data: {},
    });
    await appendSessionEvent(value.paths, config, abandonedAttempt.meta, {
      src: "user",
      kind: "outcome.recorded",
      data: { disposition: "abandoned" },
    });
    expect(
      (await getWorkItemBrief(abandoned.item.wid, {
        paths: value.paths,
        env: value.env,
      })).attempts[0],
    ).toMatchObject({ state: "inconsistent", corroborated: false });
  });

  test("rejects a non-merge outcome before mutating the base branch", async () => {
    const value = await fixture();
    const created = await createWorkItem({
      repositoryPath: value.repositoryPath,
      key: "intelligence/outcome-before-merge",
      title: "Refuse merge after an abandoned outcome",
      paths: value.paths,
      env: value.env,
    });
    const started = await startWorkSession(created.item.wid, {
      paths: value.paths,
      env: value.env,
    });
    await writeFile(join(started.meta.worktreePath, "change.txt"), "change\n");
    await git(started.meta.worktreePath, ["add", "--", "change.txt"]);
    await git(started.meta.worktreePath, ["commit", "-m", "candidate change"]);
    const baseHead = await git(value.repositoryPath, ["rev-parse", "HEAD"]);
    const config = loadConfig(
      value.paths,
      started.meta.repositoryPath,
      value.env,
    );
    await appendSessionEvent(value.paths, config, started.meta, {
      src: "user",
      kind: "outcome.recorded",
      data: { disposition: "abandoned" },
    });

    await expect(
      mergeSession(started.meta.sid, {
        paths: value.paths,
        env: value.env,
      }),
    ).rejects.toMatchObject({ code: "session.outcome_conflict" });
    expect(await git(value.repositoryPath, ["rev-parse", "HEAD"])).toBe(baseHead);
  });

  test("exposes the work lifecycle through stable JSON CLI output", async () => {
    const value = await fixture();
    const output: string[] = [];
    const errors: string[] = [];
    const runtime = {
      env: value.env,
      stdout: (line: string) => output.push(line),
      stderr: (line: string) => errors.push(line),
      stdinIsTTY: false,
      readStdin: async () => "Candidate CLI\r\n  learning\n",
    };

    expect(await runCli(["--help"], runtime)).toBe(0);
    const help = output.pop()!;
    expect(help).toContain("dsp work repair [--json]");
    expect(help).toContain("--base <local-branch>");

    expect(
      await runCli(
        [
          "work",
          "create",
          "CLI intelligence",
          "--key",
          "intelligence/cli",
          "--repo",
          value.repositoryPath,
          "--json",
        ],
        runtime,
      ),
    ).toBe(0);
    const created = JSON.parse(output.pop()!) as {
      item: { wid: string };
    };

    expect(
      await runCli(["new", "--work", created.item.wid, "--json"], runtime),
    ).toBe(0);
    const session = JSON.parse(output.pop()!) as {
      sid: string;
      workId: string;
      worktreePath: string;
    };
    expect(session.workId).toBe(created.item.wid);

    expect(
      await runCli(
        [
          "work",
          "note",
          created.item.wid,
          "--kind",
          "learning",
          "--session",
          session.sid,
          "--stdin",
          "--json",
        ],
        runtime,
      ),
    ).toBe(0);
    const noted = JSON.parse(output.pop()!) as {
      insights: Array<{ body: string }>;
    };
    expect(noted.insights).toHaveLength(1);
    expect(noted.insights[0]?.body).toBe("Candidate CLI learning");

    expect(
      await runCli(
        ["work", "ls", "--repo", value.repositoryPath],
        runtime,
      ),
    ).toBe(0);
    const listLines = output.splice(0);
    expect(listLines[0]).toBe("WID\tSTATUS\tPRIORITY\tKEY\tTITLE");
    expect(listLines[1]).toContain("intelligence/cli");

    expect(await runCli(["work", "show", created.item.wid], runtime)).toBe(0);
    const showLines = output.splice(0);
    expect(showLines.some((line) => line.startsWith("evidence\t"))).toBeTrue();
    expect(showLines.some((line) => line.includes("Candidate CLI learning")))
      .toBeTrue();

    expect(
      await runCli(
        [
          "work",
          "brief",
          "CLI intelligence",
          "--repo",
          value.repositoryPath,
        ],
        runtime,
      ),
    ).toBe(0);
    const humanBriefLines = output.splice(0);
    expect(humanBriefLines.some((line) => line.startsWith("match\t"))).toBeTrue();
    expect(humanBriefLines.some((line) => line.includes("CLI intelligence")))
      .toBeTrue();

    expect(
      await runCli(
        [
          "work",
          "brief",
          "CLI intelligence",
          "--repo",
          value.repositoryPath,
          "--json",
        ],
        runtime,
      ),
    ).toBe(0);
    const brief = JSON.parse(output.pop()!) as { matches: unknown[] };
    expect(brief.matches).toHaveLength(1);

    expect(await runCli(["work", "repair", "--json"], runtime)).toBe(0);
    const repair = JSON.parse(output.pop()!) as {
      repaired: boolean;
      bytesRemoved: number;
      lastSequence: number;
    };
    expect(repair).toMatchObject({
      repaired: false,
      bytesRemoved: 0,
    });
    expect(repair.lastSequence).toBeGreaterThan(0);

    await git(session.worktreePath, [
      "commit",
      "--allow-empty",
      "-m",
      "complete CLI intelligence",
    ]);
    expect(await runCli(["merge", session.sid, "--json"], runtime)).toBe(0);
    const merged = JSON.parse(output.pop()!) as { headCommit: string };
    expect(merged.headCommit).toBe(
      await git(value.repositoryPath, ["rev-parse", "HEAD"]),
    );
    expect(
      await runCli(
        ["work", "status", created.item.wid, "done", "--json"],
        runtime,
      ),
    ).toBe(0);
    expect(
      (JSON.parse(output.pop()!) as { status: string }).status,
    ).toBe("done");
    expect(await runCli(["remove", session.sid, "--json"], runtime)).toBe(0);
    expect((JSON.parse(output.pop()!) as { alreadyAbsent: boolean }).alreadyAbsent)
      .toBeFalse();

    await appendFile(value.paths.workEventsPath, "{}\n", "utf8");
    expect(await runCli(["work", "repair", "--json"], runtime)).toBe(1);
    const refused = JSON.parse(errors.pop()!) as {
      error: {
        code: string;
        details: { issues: Array<{ code: string; line: number }> };
      };
    };
    expect(refused.error.code).toBe("work.ledger_corrupt");
    expect(refused.error.details.issues[0]).toMatchObject({
      code: "malformed-record",
    });
  });
});
