import { createHash } from "node:crypto";
import type { WorkItem, WorkQueryScore } from "./types";

/**
 * Stable keys deliberately accept a small ASCII subset. Normalization makes
 * case and whitespace canonical but never silently drops punctuation.
 */
export const WORK_KEY_PATTERN =
  /^[a-z0-9]+(?:[._\/-][a-z0-9]+)*$/;

const MAX_WORK_KEY_LENGTH = 128;

export function normalizeWorkKey(value: string): string {
  if (typeof value !== "string") {
    throw new TypeError("work key must be a string");
  }

  const normalized = value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\p{White_Space}]+/gu, "-");

  if (
    normalized.length === 0 ||
    normalized.length > MAX_WORK_KEY_LENGTH ||
    !WORK_KEY_PATTERN.test(normalized)
  ) {
    throw new TypeError(
      "work key must be 1..128 lowercase ASCII letters and digits separated by dots, underscores, hyphens, or slashes",
    );
  }

  return normalized;
}

/**
 * Canonicalizes human text without changing words or punctuation. All Unicode
 * whitespace, including normalized CRLF/newline boundaries, becomes one space.
 */
export function normalizeWorkText(value: string): string {
  if (typeof value !== "string") {
    throw new TypeError("work text must be a string");
  }

  return value
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\p{White_Space}]+/gu, " ")
    .trim();
}

/**
 * Produces an exact, deterministic duplicate-check fingerprint. Objective is
 * authoritative when present; title is the fallback. The tuple encoding
 * avoids delimiter ambiguity.
 */
export function fingerprintWork(
  repositoryKey: string,
  title: string,
  objective: string | null = null,
): string {
  if (typeof repositoryKey !== "string") {
    throw new TypeError("repositoryKey must be a string");
  }
  const canonicalRepositoryKey = repositoryKey;
  const normalizedTitle = normalizeWorkText(title);
  const normalizedObjective =
    objective === null ? null : normalizeWorkText(objective);

  if (
    canonicalRepositoryKey.length === 0 ||
    canonicalRepositoryKey.trim() !== canonicalRepositoryKey
  ) {
    throw new TypeError("repositoryKey is required");
  }
  if (normalizedTitle.length === 0) {
    throw new TypeError("title is required");
  }
  if (normalizedObjective !== null && normalizedObjective.length === 0) {
    throw new TypeError("objective must be null or non-empty");
  }

  const identityText = normalizedObjective ?? normalizedTitle;
  return createHash("sha256")
    .update(JSON.stringify([canonicalRepositoryKey, identityText]), "utf8")
    .digest("hex");
}

export function tokenizeWorkText(value: string): readonly string[] {
  const normalized = normalizeWorkText(value).toLocaleLowerCase("en-US");
  const tokens = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(tokens)].sort(compareTokens);
}

/**
 * Transparent lexical overlap for ranking only. It is neither semantic
 * similarity nor evidence that two work items are duplicates.
 */
export function scoreWorkQuery(
  query: string,
  item: WorkItem,
): WorkQueryScore {
  const queryTokens = tokenizeWorkText(query);
  if (queryTokens.length === 0) {
    return { score: 0, sharedTokens: [] };
  }

  const candidateTokens = new Set(
    tokenizeWorkText(
      [item.key, item.title, item.objective, item.externalRef]
        .filter((value): value is string => value !== null)
        .join(" "),
    ),
  );
  const querySet = new Set(queryTokens);
  const sharedTokens = queryTokens.filter((token) => candidateTokens.has(token));
  const unionSize = new Set([...querySet, ...candidateTokens]).size;

  return {
    score: unionSize === 0 ? 0 : sharedTokens.length / unionSize,
    sharedTokens,
  };
}

function compareTokens(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
