#!/usr/bin/env bun

import { runHookProcess } from "./run";

const keepAlive = setInterval(() => {}, 2_147_483_647);

void runHookProcess().then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
).finally(() => clearInterval(keepAlive));
