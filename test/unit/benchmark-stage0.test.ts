import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  parseBenchmarkOptions,
  summarizeSamples,
} from "../../scripts/benchmark-stage0";

describe("Stage 0 benchmark evidence", () => {
  test("summarizes samples with nearest-rank percentiles", () => {
    expect(summarizeSamples([9, 1, 5, 3, 7])).toEqual({
      count: 5,
      minimumMs: 1,
      medianMs: 5,
      p95Ms: 9,
      maximumMs: 9,
      meanMs: 5,
    });
  });

  test("rounds recorded durations without changing their ordering", () => {
    expect(summarizeSamples([1.1114, 1.1115, 1.1116])).toEqual({
      count: 3,
      minimumMs: 1.111,
      medianMs: 1.112,
      p95Ms: 1.112,
      maximumMs: 1.112,
      meanMs: 1.112,
    });
  });

  test("parses explicit reproducibility controls", () => {
    expect(
      parseBenchmarkOptions(
        [
          "--binary",
          "artifact/dsp.exe",
          "--iterations",
          "12",
          "--warmup",
          "3",
          "--sessions",
          "500",
          "--output",
          "evidence/result.json",
        ],
        { binary: "ignored" },
      ),
    ).toEqual({
      binary: resolve("artifact/dsp.exe"),
      iterations: 12,
      warmup: 3,
      sessions: 500,
      output: resolve("evidence/result.json"),
    });
  });

  test("rejects ambiguous and unsafe options", () => {
    expect(() => summarizeSamples([])).toThrow(TypeError);
    expect(() => parseBenchmarkOptions(["--iterations", "0"])).toThrow(
      RangeError,
    );
    expect(() =>
      parseBenchmarkOptions(["--iterations", "2", "--iterations", "3"]),
    ).toThrow("Option may be supplied only once");
    expect(() => parseBenchmarkOptions(["--unknown", "1"])).toThrow(
      "Unknown option",
    );
  });
});
