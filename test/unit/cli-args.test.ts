import { describe, expect, test } from "bun:test";

import {
  booleanOption,
  integerOption,
  parseArguments,
  stringOption,
} from "../../src/cli/args";

describe("CLI argument parsing", () => {
  test("parses explicit long options and positionals", () => {
    const parsed = parseArguments(
      ["session", "--repo", "/tmp/repo", "--json", "--limit=20"],
      {
        repo: { type: "string" },
        json: { type: "boolean" },
        limit: { type: "string" },
      },
    );

    expect(parsed.positionals).toEqual(["session"]);
    expect(stringOption(parsed, "repo")).toBe("/tmp/repo");
    expect(booleanOption(parsed, "json")).toBe(true);
    expect(integerOption(parsed, "limit")).toBe(20);
  });

  test("honors the positional delimiter", () => {
    const parsed = parseArguments(["--", "--not-an-option"], {});
    expect(parsed.positionals).toEqual(["--not-an-option"]);
  });

  test("rejects unknown, duplicated, and missing options", () => {
    expect(() => parseArguments(["--wat"], {})).toThrow("Unknown option");
    expect(() =>
      parseArguments(["--json", "--json"], { json: { type: "boolean" } }),
    ).toThrow("only once");
    expect(() =>
      parseArguments(["--repo"], { repo: { type: "string" } }),
    ).toThrow("requires a value");
  });
});
