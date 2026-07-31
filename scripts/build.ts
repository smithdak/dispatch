import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const dist = join(root, "dist");
const mode = process.argv[2] ?? "--host";

const matrix = [
  { target: "bun-windows-x64", output: "dsp-windows-x64.exe" },
  { target: "bun-linux-x64", output: "dsp-linux-x64" },
  { target: "bun-linux-arm64", output: "dsp-linux-arm64" },
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
    "--define=__DISPATCH_STANDALONE__=true",
    `--outfile=${join(dist, output)}`,
  ];
  if (target) args.push(`--target=${target}`);

  // Preserve the repository pin even when the caller uses a portable Bun
  // that is not first on PATH.
  const child = Bun.spawn([process.execPath, ...args], {
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
