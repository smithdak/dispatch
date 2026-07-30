import { describe, expect, test } from "bun:test";
import {
  CROCKFORD_BASE32_ALPHABET,
  assertSortableId,
  createSortableId,
  decodeSortableId,
  isSortableId,
} from "../../src/core/identity";

describe("sortable identity", () => {
  test("encodes timestamp and entropy in canonical Crockford Base32", () => {
    const id = createSortableId({
      timestamp: 0,
      randomBytes: () =>
        Uint8Array.from([
          0, 31, 10, 20, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
        ]),
    });

    expect(id).toBe("0000000000-0zam123456789abc");
    expect(decodeSortableId(id)).toEqual({
      timestamp: 0,
      random: "0zam123456789abc",
    });
  });

  test("round-trips contemporary millisecond timestamps exactly", () => {
    const timestamp = Date.UTC(2026, 6, 30, 15, 4, 5, 123);
    const id = createSortableId({
      timestamp: new Date(timestamp),
      randomBytes: () => new Uint8Array(16),
    });

    expect(decodeSortableId(id).timestamp).toBe(timestamp);
    expect(isSortableId(id)).toBe(true);
  });

  test("sorts lexicographically by timestamp", () => {
    const entropy = () => new Uint8Array(16);
    const earlier = createSortableId({ timestamp: 1_000, randomBytes: entropy });
    const later = createSortableId({ timestamp: 1_001, randomBytes: entropy });

    expect([later, earlier].sort()).toEqual([earlier, later]);
  });

  test("uses every byte without modulo bias", () => {
    const id = createSortableId({
      timestamp: 1,
      randomBytes: () =>
        Uint8Array.from([
          0, 32, 64, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ]),
    });

    expect(id.slice(-16, -12)).toBe(
      `${CROCKFORD_BASE32_ALPHABET[0]}${CROCKFORD_BASE32_ALPHABET[0]}${CROCKFORD_BASE32_ALPHABET[0]}${CROCKFORD_BASE32_ALPHABET[31]}`,
    );
  });

  test.each([
    "0000000000-000000000000000",
    "00000000000-0000000000000000",
    "0000000000-000000000000000o",
    "0000000000-000000000000000u",
    "0000000000-000000000000000I",
    "0000000000_0000000000000000",
  ])("rejects non-canonical ID %s", (value) => {
    expect(isSortableId(value)).toBe(false);
    expect(() => assertSortableId(value)).toThrow(TypeError);
  });

  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid timestamp %p",
    (timestamp) => {
      expect(() => createSortableId({ timestamp })).toThrow(RangeError);
    },
  );

  test("rejects an entropy source that returns too few bytes", () => {
    expect(() =>
      createSortableId({
        timestamp: 0,
        randomBytes: () => new Uint8Array(15),
      }),
    ).toThrow(TypeError);
  });
});
