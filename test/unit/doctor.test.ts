import { describe, expect, test } from "bun:test";

import {
  bunDoctorCheck,
  platformDoctorCheck,
} from "../../src/application/doctor";

describe("doctor runtime qualification", () => {
  test("accepts the pinned Bun runtime", () => {
    expect(bunDoctorCheck("1.3.14", "win32", "x64")).toEqual({
      name: "bun",
      status: "ok",
      detail: "1.3.14",
    });
  });

  test("keeps the locally qualified legacy runtime ready with a warning", () => {
    expect(bunDoctorCheck("1.3.6", "win32", "x64")).toMatchObject({
      name: "bun",
      status: "warn",
    });
    expect(bunDoctorCheck("1.3.6", "linux", "x64").status).toBe(
      "fail",
    );
  });

  test("fails every unqualified Bun version", () => {
    for (const version of [
      "1.3.5",
      "1.3.13",
      "1.3.20",
      "1.4.0",
      "unknown",
    ]) {
      expect(bunDoctorCheck(version, "win32", "x64").status).toBe(
        "fail",
      );
    }
  });

  test("makes Windows x64 the primary v1 target", () => {
    expect(platformDoctorCheck("win32", "x64")).toEqual({
      name: "platform",
      status: "ok",
      detail: "win32/x64; primary v1 target",
    });
    expect(platformDoctorCheck("linux", "x64")).toMatchObject({
      status: "ok",
    });
    expect(platformDoctorCheck("darwin", "arm64").status).toBe("fail");
  });
});
