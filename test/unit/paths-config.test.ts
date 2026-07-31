import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, sep } from "node:path";

import { loadConfig } from "../../src/core/config";
import {
  ensureMachineId,
  pathKey,
  physicalPath,
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

  test("resolve native Windows application-data roots", () => {
    const root = temporaryDirectory();
    const local = join(root, "Local App Data");
    const roaming = join(root, "Roaming App Data");
    const paths = resolveDispatchPaths(
      {
        USERPROFILE: root,
        LOCALAPPDATA: local,
        APPDATA: roaming,
      },
      "win32",
    );

    expect(paths.stateDir).toBe(join(local, "dispatch"));
    expect(paths.cacheDir).toBe(join(local, "dispatch"));
    expect(paths.defaultWorktreeRoot).toBe(
      join(local, "dispatch", "worktrees"),
    );
    expect(paths.globalConfigPath).toBe(
      join(roaming, "dispatch", "config.toml"),
    );
  });

  test("treats Windows path case as one physical identity", () => {
    if (process.platform !== "win32") return;
    const root = temporaryDirectory();
    expect(pathKey(root.toUpperCase())).toBe(pathKey(root.toLowerCase()));
  });

  test("canonicalizes aliases before retaining missing descendants", () => {
    const root = temporaryDirectory();
    const target = join(root, "physical-root");
    const alias = join(root, "path-alias");
    mkdirSync(target);
    symlinkSync(
      target,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );

    const expected = join(
      realpathSync.native(target),
      "future",
      "worktree",
    );
    const throughAlias = join(alias, "future", "worktree");
    expect(physicalPath(throughAlias)).toBe(expected);
    expect(pathKey(throughAlias)).toBe(pathKey(expected));
  });

  test("preserves roots and valid platform-specific path characters", () => {
    const root = temporaryDirectory();
    const platformRoot = parse(root).root;
    expect(physicalPath(platformRoot)).toBe(platformRoot);

    const directory = join(root, "trailing-separator");
    mkdirSync(directory);
    expect(physicalPath(`${directory}${sep}`)).toBe(
      realpathSync.native(directory),
    );

    if (process.platform !== "win32") {
      const trailingBackslash = join(root, "valid-backslash\\");
      mkdirSync(trailingBackslash);
      expect(physicalPath(trailingBackslash)).toBe(
        realpathSync.native(trailingBackslash),
      );
    }
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
