import {
  closeSync,
  constants,
  copyFileSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

interface ProbeOptions {
  readonly directory: string;
  readonly bytes: number;
}

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function options(): ProbeOptions {
  const directory = resolve(readOption("--directory") ?? tmpdir());
  const bytesValue = readOption("--bytes");
  const bytes = bytesValue
    ? Number.parseInt(bytesValue, 10)
    : 500 * 1024 * 1024;
  if (!Number.isSafeInteger(bytes) || bytes < 1024 || bytes > 4 * 1024 ** 3) {
    throw new Error("--bytes must be an integer from 1024 through 4294967296.");
  }
  return { directory, bytes };
}

function createSource(path: string, bytes: number): void {
  const descriptor = openSync(path, "wx");
  const chunk = Buffer.alloc(1024 * 1024, 0x41);
  try {
    let remaining = bytes;
    while (remaining > 0) {
      const length = Math.min(chunk.length, remaining);
      writeSync(descriptor, chunk, 0, length);
      remaining -= length;
    }
  } finally {
    closeSync(descriptor);
  }
}

function writeByte(path: string, value: number): void {
  const descriptor = openSync(path, "r+");
  try {
    writeSync(descriptor, Buffer.from([value]), 0, 1, 0);
  } finally {
    closeSync(descriptor);
  }
}

function readByte(path: string): number {
  const descriptor = openSync(path, "r");
  const buffer = Buffer.alloc(1);
  try {
    readSync(descriptor, buffer, 0, 1, 0);
    return buffer[0] ?? -1;
  } finally {
    closeSync(descriptor);
  }
}

const probe = options();
const root = mkdtempSync(join(probe.directory, "dispatch-reflink-"));
const source = join(root, "source.bin");
const clone = join(root, "clone.bin");

try {
  const sourceStarted = performance.now();
  createSource(source, probe.bytes);
  const sourceDurationMs = performance.now() - sourceStarted;

  const cloneStarted = performance.now();
  copyFileSync(source, clone, constants.COPYFILE_FICLONE_FORCE);
  const cloneDurationMs = performance.now() - cloneStarted;

  writeByte(clone, 0x42);
  const sourceAfterCloneWrite = readByte(source);
  writeByte(source, 0x43);
  const cloneAfterSourceWrite = readByte(clone);
  const divergenceSafe =
    sourceAfterCloneWrite === 0x41 && cloneAfterSourceWrite === 0x42;

  console.log(
    JSON.stringify(
      {
        filesystemPath: probe.directory,
        bytes: probe.bytes,
        mechanism: "COPYFILE_FICLONE_FORCE",
        sourceDurationMs: Math.round(sourceDurationMs * 100) / 100,
        cloneDurationMs: Math.round(cloneDurationMs * 100) / 100,
        divergenceSafe,
      },
      null,
      2,
    ),
  );

  if (!divergenceSafe) process.exitCode = 1;
} catch (error) {
  console.error(
    JSON.stringify(
      {
        filesystemPath: probe.directory,
        bytes: probe.bytes,
        mechanism: "COPYFILE_FICLONE_FORCE",
        supported: false,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
