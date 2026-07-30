#!/usr/bin/env bun

export {};

async function main(args: readonly string[]): Promise<number> {
  if (args[0] === "hook") {
    const { runHookProcess } = await import("../hook/run");
    return runHookProcess(args.slice(1));
  }

  const { runCli } = await import("./run");
  return runCli(args);
}

// Bun 1.3.6 can terminate a compiled program while Bun.stdin.text() or a
// dynamic import is the only pending work. Top-level await is rejected by the
// bytecode compiler, so keep one referenced handle until the root promise
// settles. This is also exercised through a real subprocess in the contract
// suite.
const keepAlive = setInterval(() => {}, 2_147_483_647);

void main(process.argv.slice(2)).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
).finally(() => clearInterval(keepAlive));
