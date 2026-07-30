import { randomBytes as nodeRandomBytes } from "node:crypto";

/**
 * Crockford Base32 without the ambiguous I, L, O, and U characters.
 *
 * IDs are emitted in lowercase so their bytewise and locale-independent
 * lexicographic order is canonical.
 */
export const CROCKFORD_BASE32_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

const TIMESTAMP_LENGTH = 10;
// Sixteen Base32 characters retain 80 independent random bits. The four
// character sketch in arch.md carries only 20 bits and is not collision-safe
// for a durable, federatable event identity.
const RANDOM_LENGTH = 16;
const MAX_TIMESTAMP = 32 ** TIMESTAMP_LENGTH - 1;

export const SORTABLE_ID_PATTERN =
  /^[0-9abcdefghjkmnpqrstvwxyz]{10}-[0-9abcdefghjkmnpqrstvwxyz]{16}$/;

export interface SortableIdOptions {
  /**
   * Milliseconds since the Unix epoch. Defaults to Date.now().
   */
  readonly timestamp?: number | Date;

  /**
   * Injectable entropy source for deterministic tests.
   */
  readonly randomBytes?: (length: number) => Uint8Array;
}

export interface DecodedSortableId {
  readonly timestamp: number;
  readonly random: string;
}

/**
 * Creates a fixed-width, time-sortable ID:
 *
 *     <10 Crockford Base32 timestamp chars>-<16 random chars>
 */
export function createSortableId(options: SortableIdOptions = {}): string {
  const timestamp = normalizeTimestamp(options.timestamp);
  const entropy = (options.randomBytes ?? nodeRandomBytes)(RANDOM_LENGTH);

  if (!(entropy instanceof Uint8Array) || entropy.length < RANDOM_LENGTH) {
    throw new TypeError(
      `randomBytes must return at least ${RANDOM_LENGTH} bytes`,
    );
  }

  let suffix = "";
  for (let index = 0; index < RANDOM_LENGTH; index += 1) {
    // The alphabet has 32 entries, so masking a uniform byte is unbiased.
    suffix += CROCKFORD_BASE32_ALPHABET[entropy[index]! & 31];
  }

  return `${encodeTimestamp(timestamp)}-${suffix}`;
}

export function isSortableId(value: unknown): value is string {
  if (typeof value !== "string" || !SORTABLE_ID_PATTERN.test(value)) {
    return false;
  }

  try {
    decodeSortableId(value);
    return true;
  } catch {
    return false;
  }
}

export function assertSortableId(
  value: unknown,
  field = "id",
): asserts value is string {
  if (!isSortableId(value)) {
    throw new TypeError(
      `${field} must be a canonical sortable ID (10 Crockford Base32 timestamp characters, a hyphen, and 16 random characters)`,
    );
  }
}

export function decodeSortableId(value: string): DecodedSortableId {
  if (
    typeof value !== "string" ||
    value.length !== TIMESTAMP_LENGTH + 1 + RANDOM_LENGTH ||
    value[TIMESTAMP_LENGTH] !== "-"
  ) {
    throw new TypeError("Invalid sortable ID format");
  }

  const timestampPart = value.slice(0, TIMESTAMP_LENGTH);
  const random = value.slice(TIMESTAMP_LENGTH + 1);

  let timestamp = 0;
  for (const character of timestampPart) {
    const digit = CROCKFORD_BASE32_ALPHABET.indexOf(character);
    if (digit < 0) {
      throw new TypeError("Invalid Crockford Base32 timestamp");
    }
    timestamp = timestamp * 32 + digit;
  }

  for (const character of random) {
    if (!CROCKFORD_BASE32_ALPHABET.includes(character)) {
      throw new TypeError("Invalid Crockford Base32 random suffix");
    }
  }

  if (!Number.isSafeInteger(timestamp) || timestamp > MAX_TIMESTAMP) {
    throw new RangeError("Sortable ID timestamp is outside the supported range");
  }

  return { timestamp, random };
}

function normalizeTimestamp(value: number | Date | undefined): number {
  const timestamp =
    value === undefined
      ? Date.now()
      : value instanceof Date
        ? value.getTime()
        : value;

  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0 ||
    timestamp > MAX_TIMESTAMP
  ) {
    throw new RangeError(
      `timestamp must be an integer between 0 and ${MAX_TIMESTAMP}`,
    );
  }

  return timestamp;
}

function encodeTimestamp(timestamp: number): string {
  let remaining = timestamp;
  const encoded = Array<string>(TIMESTAMP_LENGTH).fill("0");

  for (let index = TIMESTAMP_LENGTH - 1; index >= 0; index -= 1) {
    encoded[index] = CROCKFORD_BASE32_ALPHABET[remaining % 32]!;
    remaining = Math.floor(remaining / 32);
  }

  return encoded.join("");
}
