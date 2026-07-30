import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../../src/core/config";
import {
  ensureMachineId,
  resolveDispatchPaths,
} from "../../src/core/paths";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const value = mkdtempSync(join(tmpdir(), "dispatch-paths-"));
  temporaryDirectories.push(value);
  return value;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("dispatch paths", () => {
  test("resolve from XDG roots without reading global process state", () => {
    const root = temporaryDirectory();
    const paths = resolveDispatchPaths(
      {
        HOME: root,
        XDG_STATE_HOME: join(root, "state"),
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_CACHE_HOME: join(root, "cache"),
        XDG_DATA_HOME: join(root, "data"),
      },
      "linux",
    );

    expect(paths.stateDir).toBe(join(root, "state", "dispatch"));
    expect(paths.globalConfigPath).toBe(
      join(root, "config", "dispatch", "config.toml"),
    );
    expect(paths.templatesDir).toBe(join(root, "cache", "dispatch", "templates"));
    expect(paths.defaultWorktreeRoot).toBe(
      join(root, "data", "dispatch", "worktrees"),
    );
  });

  test("persist and reuse a machine identity", () => {
    const root = temporaryDirectory();
    const paths = resolveDispatchPaths({ HOME: root, DISPATCH_HOME: root }, "linux");
    const first = ensureMachineId(paths);
    const second = ensureMachineId(paths);

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-z0-9][a-z0-9._-]{2,63}$/);
  });
});

describe("configuration", () => {
  test("merge global and project TOML with project precedence", () => {
    const root = temporaryDirectory();
    const repository = join(root, "repository");
    const paths = resolveDispatchPaths(
      {
        HOME: root,
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_DATA_HOME: join(root, "data"),
      },
      "linux",
    );
    mkdirSync(paths.configDir, { recursive: true });
    mkdirSync(repository, { recursive: true });
    writeFileSync(
      paths.globalConfigPath,
      [
        "[worktrees]",
        `root = "${join(root, "global").replaceAll("\\", "\\\\")}"`,
        'branch_prefix = "dispatch/"',
        "[ledger]",
        "fsync = true",
        "lock_timeout_ms = 1000",
      ].join("\n"),
    );
    writeFileSync(
      join(repository, ".dispatch.toml"),
      ["[worktrees]", 'branch_prefix = "agents/"', "[ledger]", "fsync = false"].join(
        "\n",
      ),
    );

    const config = loadConfig(paths, repository, { HOME: root });
    expect(config.worktrees.root).toBe(join(root, "global"));
    expect(config.worktrees.branchPrefix).toBe("agents/");
    expect(config.ledger).toEqual({ fsync: false, lockTimeoutMs: 1000 });
  });

  test("reject unknown keys instead of silently ignoring typos", () => {
    const root = temporaryDirectory();
    const paths = resolveDispatchPaths(
      { HOME: root, XDG_CONFIG_HOME: join(root, "config") },
      "linux",
    );
    mkdirSync(paths.configDir, { recursive: true });
    writeFileSync(paths.globalConfigPath, "[ledger]\nfsnyc = true\n");

    expect(() => loadConfig(paths, undefined, { HOME: root })).toThrow(
      "Unknown config key",
    );
  });
});
