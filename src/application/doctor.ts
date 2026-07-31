import { existsSync, readFileSync } from "node:fs";

import { resolveDispatchPaths } from "../core/paths";
import { MuxError } from "../ports/mux";

export type DoctorCheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  readonly name: string;
  readonly status: DoctorCheckStatus;
  readonly detail: string;
}

export interface DoctorReport {
  readonly readyForStage0: boolean;
  readonly readyForStage1: boolean;
  readonly checks: readonly DoctorCheck[];
}

export const PINNED_BUN_VERSION = "1.3.14";
export const LEGACY_WINDOWS_QUALIFIED_BUN_VERSION = "1.3.6";

export function bunDoctorCheck(
  version: string,
  platform: NodeJS.Platform,
  architecture: string,
): DoctorCheck {
  if (version === PINNED_BUN_VERSION) {
    return { name: "bun", status: "ok", detail: PINNED_BUN_VERSION };
  }

  if (
    version === LEGACY_WINDOWS_QUALIFIED_BUN_VERSION &&
    platform === "win32" &&
    architecture === "x64"
  ) {
    return {
      name: "bun",
      status: "warn",
      detail: `${version}; locally qualified legacy Windows x64 runtime, release pin is ${PINNED_BUN_VERSION}`,
    };
  }

  return {
    name: "bun",
    status: "fail",
    detail: `${version}; ${PINNED_BUN_VERSION} is the release runtime; ${LEGACY_WINDOWS_QUALIFIED_BUN_VERSION} is qualified only on Windows x64`,
  };
}

export function platformDoctorCheck(
  platform: NodeJS.Platform,
  architecture: string,
): DoctorCheck {
  if (platform === "win32" && architecture === "x64") {
    return {
      name: "platform",
      status: "ok",
      detail: `${platform}/${architecture}; primary v1 target`,
    };
  }
  if (platform === "linux" && architecture === "x64") {
    return {
      name: "platform",
      status: "ok",
      detail: `${platform}/${architecture}; secondary v1 target`,
    };
  }
  return {
    name: "platform",
    status: "fail",
    detail: `${platform}/${architecture}; v1 targets Windows x64 and Linux x64`,
  };
}

async function executableVersion(
  executable: string,
  args: readonly string[],
): Promise<string | null> {
  const path = Bun.which(executable);
  if (!path) return null;
  const child = Bun.spawn([path, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  return exitCode === 0 ? stdout.trim() : path;
}

export async function diagnose(): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  checks.push(bunDoctorCheck(Bun.version, process.platform, process.arch));
  checks.push(platformDoctorCheck(process.platform, process.arch));

  const gitVersion = await executableVersion("git", ["--version"]);
  checks.push({
    name: "git",
    status: gitVersion ? "ok" : "fail",
    detail: gitVersion ?? "not found on PATH",
  });

  let herdrReady = false;
  if (process.platform === "win32" && process.arch === "x64") {
    try {
      const { loadMuxPort } = await import("../adapters/registry");
      const capabilities = await (await loadMuxPort()).probe();
      herdrReady = true;
      checks.push({
        name: "herdr",
        status: "ok",
        detail: `${capabilities.clientVersion}; protocol ${capabilities.protocol}; detached server ${capabilities.detachedServerDaemon ? "available" : "unavailable"}`,
      });
    } catch (error) {
      checks.push({
        name: "herdr",
        status: "warn",
        detail:
          error instanceof MuxError
            ? `${error.code}: ${error.message}; required for Stage 1 only`
            : `${error instanceof Error ? error.message : String(error)}; required for Stage 1 only`,
      });
    }
  } else {
    checks.push({
      name: "herdr",
      status: "warn",
      detail: "native Herdr orchestration is qualified only on Windows x64",
    });
  }

  const paths = resolveDispatchPaths();
  const machineId = existsSync(paths.machineIdPath)
    ? readFileSync(paths.machineIdPath, "utf8").trim()
    : null;
  checks.push({
    name: "state",
    status: "ok",
    detail: machineId
      ? `${paths.stateDir}; machine ${machineId}`
      : `${paths.stateDir}; initialized on first session`,
  });

  const readyForStage0 = checks
    .filter((check) => check.name !== "herdr")
    .every((check) => check.status !== "fail");
  return {
    readyForStage0,
    readyForStage1: readyForStage0 && herdrReady,
    checks,
  };
}
