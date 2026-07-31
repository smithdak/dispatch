import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../../src/cli/run";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-cli-hooks-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("hooks install CLI", () => {
  test("defaults to inherited Claude user scope", async () => {
    const home = temporaryDirectory();
    const output: string[] = [];

    const exitCode = await runCli(
      [
        "hooks",
        "install",
        "claude",
        "--command",
        join(home, "dsp.exe"),
      ],
      {
        env: { HOME: home },
        stdout: (value) => output.push(value),
      },
    );

    expect(exitCode).toBe(0);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(true);
    expect(output[0]).toContain("\tuser\t");
    expect(output[1]).toContain("future Dispatch worktrees inherit");
    expect(output[1]).toContain("outside Dispatch worktrees are ignored");
  });

  test("makes explicit project-local scope and its limitation visible", async () => {
    const root = temporaryDirectory();
    const home = join(root, "home");
    const project = join(root, "project");
    const output: string[] = [];

    const exitCode = await runCli(
      [
        "hooks",
        "install",
        "claude",
        "--project",
        project,
        "--command",
        join(root, "dsp.exe"),
      ],
      {
        env: { HOME: home },
        stdout: (value) => output.push(value),
      },
    );

    expect(exitCode).toBe(0);
    expect(
      existsSync(join(project, ".claude", "settings.local.json")),
    ).toBe(true);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
    expect(output[0]).toContain("\tproject\t");
    expect(output[1]).toBe(
      "Project-local only: this hook is not inherited by future Dispatch worktrees.",
    );
  });

  test("reports scope and inheritance in JSON output", async () => {
    const home = temporaryDirectory();
    const output: string[] = [];

    const exitCode = await runCli(
      [
        "hooks",
        "install",
        "claude",
        "--command",
        join(home, "dsp.exe"),
        "--json",
      ],
      {
        env: { HOME: home },
        stdout: (value) => output.push(value),
      },
    );
    const result = JSON.parse(output[0]!) as Record<string, unknown>;

    expect(exitCode).toBe(0);
    expect(result.scope).toBe("user");
    expect(result.inheritedByFutureWorktrees).toBe(true);
    expect(result.path).toBe(join(home, ".claude", "settings.json"));
  });
});
