import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("the CLI hook entrypoint remains alive until stdin is consumed", async () => {
  const entrypoint = resolve(import.meta.dir, "../../src/cli/main.ts");
  const child = Bun.spawn(
    [process.execPath, entrypoint, "hook", "claude"],
    {
      cwd: resolve(import.meta.dir, "../.."),
      env: process.env,
      stdin: new Blob(["{}\n"]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);

  expect(exitCode).toBe(1);
  expect(stderr).toContain("dispatch hook: Invalid claude hook payload:");
});
