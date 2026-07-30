import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installClaudeHooks } from "../../src/application/hook-settings";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-hooks-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Claude hook installation", () => {
  test("defaults to user scope, preserves settings, and is idempotent", () => {
    const root = temporaryDirectory();
    const home = join(root, "home");
    const settingsDirectory = join(home, ".claude");
    mkdirSync(settingsDirectory, { recursive: true });
    writeFileSync(
      join(settingsDirectory, "settings.json"),
      `${JSON.stringify({ permissions: { allow: ["Read"] } }, null, 2)}\n`,
    );

    const first = installClaudeHooks({ env: { HOME: home } });
    const second = installClaudeHooks({ env: { HOME: home } });
    const settings = JSON.parse(readFileSync(first.path, "utf8")) as {
      permissions: { allow: string[] };
      hooks: Record<string, unknown[]>;
    };

    expect(first).toEqual({
      path: join(settingsDirectory, "settings.json"),
      changed: true,
      scope: "user",
      inheritedByFutureWorktrees: true,
    });
    expect(second).toEqual({ ...first, changed: false });
    expect(settings.permissions.allow).toEqual(["Read"]);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(
      readdirSync(settingsDirectory).filter((name) => name.includes(".tmp-")),
    ).toEqual([]);
  });

  test("keeps an explicit project installation local", () => {
    const root = temporaryDirectory();
    const home = join(root, "home");
    const project = join(root, "project");
    const settingsDirectory = join(project, ".claude");
    mkdirSync(settingsDirectory, { recursive: true });
    writeFileSync(
      join(settingsDirectory, "settings.local.json"),
      `${JSON.stringify({ model: "existing-model" }, null, 2)}\n`,
    );

    const first = installClaudeHooks({
      projectPath: project,
      env: { HOME: home },
    });
    const second = installClaudeHooks({
      projectPath: project,
      env: { HOME: home },
    });
    const settings = JSON.parse(readFileSync(first.path, "utf8")) as {
      model: string;
      hooks: Record<string, unknown[]>;
    };

    expect(first).toEqual({
      path: join(settingsDirectory, "settings.local.json"),
      changed: true,
      scope: "project",
      inheritedByFutureWorktrees: false,
    });
    expect(second).toEqual({ ...first, changed: false });
    expect(settings.model).toBe("existing-model");
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
    expect(
      readdirSync(settingsDirectory).filter((name) => name.includes(".tmp-")),
    ).toEqual([]);
  });

  test("fails closed when user scope has no injected home", () => {
    expect(() => installClaudeHooks({ env: {} })).toThrow(
      "set HOME or USERPROFILE",
    );
  });
});
