import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const dist = join(root, "dist");
const mode = process.argv[2] ?? "--host";

const matrix = [
  { target: "bun-darwin-arm64", output: "dsp-darwin-arm64" },
  { target: "bun-darwin-x64", output: "dsp-darwin-x64" },
  { target: "bun-linux-arm64", output: "dsp-linux-arm64" },
  { target: "bun-linux-x64", output: "dsp-linux-x64" },
] as const;

async function compile(target?: string, output = "dsp"): Promise<void> {
  const args = [
    "build",
    join(root, "src", "cli", "main.ts"),
    "--compile",
    "--bytecode",
    "--minify",
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    `--outfile=${join(dist, output)}`,
  ];
  if (target) args.push(`--target=${target}`);

  const child = Bun.spawn(["bun", ...args], {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`Build failed for ${target ?? "host"} (${exitCode}).`);
  }
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

if (mode === "--host") {
  await compile();
} else if (mode === "--matrix") {
  for (const entry of matrix) await compile(entry.target, entry.output);
} else {
  throw new Error(`Unknown build mode: ${mode}`);
}
