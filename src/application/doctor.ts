import { existsSync, readFileSync } from "node:fs";

import { resolveDispatchPaths } from "../core/paths";

export type DoctorCheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  readonly name: string;
  readonly status: DoctorCheckStatus;
  readonly detail: string;
}

export interface DoctorReport {
  readonly readyForStage0: boolean;
  readonly checks: readonly DoctorCheck[];
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
  const bunVersion = Bun.version;
  checks.push({
    name: "bun",
    status: bunVersion === "1.3.14" ? "ok" : "fail",
    detail:
      bunVersion === "1.3.14"
        ? "1.3.14"
        : `${bunVersion}; repository pin is 1.3.14`,
  });

  const supportedPlatform =
    process.platform === "darwin" || process.platform === "linux";
  checks.push({
    name: "platform",
    status: supportedPlatform ? "ok" : "fail",
    detail: supportedPlatform
      ? `${process.platform}/${process.arch}`
      : `${process.platform}/${process.arch}; v1 targets macOS and Linux`,
  });

  const gitVersion = await executableVersion("git", ["--version"]);
  checks.push({
    name: "git",
    status: gitVersion ? "ok" : "fail",
    detail: gitVersion ?? "not found on PATH",
  });

  const tmuxVersion = await executableVersion("tmux", ["-V"]);
  checks.push({
    name: "tmux",
    status: tmuxVersion ? "ok" : "warn",
    detail: tmuxVersion ?? "not found; required for Stage 1, not Stage 0",
  });

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

  return {
    readyForStage0: checks.every((check) => check.status !== "fail"),
    checks,
  };
}
