import { DispatchError } from "../core/errors";
import { isSortableId } from "../core/identity";
import type { ReadableEvent } from "../core/ledger";

export const PROMPT_RECEIPT_STATES = [
  "prompt.intent",
  "prompt.accepted",
  "prompt.rejected",
  "prompt.outcome_unknown",
  "prompt.unknown_acknowledged",
] as const;

export type PromptReceiptState = (typeof PROMPT_RECEIPT_STATES)[number];

export interface PromptReceipt {
  readonly promptId: string;
  readonly state: PromptReceiptState;
  readonly seq: number;
  readonly ts: string;
}

export type UnresolvedPromptReceipt = PromptReceipt & {
  readonly state: "prompt.intent" | "prompt.outcome_unknown";
};

const PROMPT_RECEIPT_STATE_SET = new Set<string>(PROMPT_RECEIPT_STATES);

function promptReceipt(event: ReadableEvent): PromptReceipt | undefined {
  if (
    event.src !== "dsp" ||
    event.kind !== "agent.state" ||
    event.data.operation !== "prompt"
  ) {
    return undefined;
  }
  const promptId = event.data.promptId;
  const state = event.data.state;
  if (
    typeof promptId !== "string" ||
    !isSortableId(promptId) ||
    typeof state !== "string" ||
    !PROMPT_RECEIPT_STATE_SET.has(state)
  ) {
    throw new DispatchError(
      "session.prompt_receipt_invalid",
      `Session ${event.sid} contains an invalid prompt control receipt at sequence ${event.seq}.`,
      { sid: event.sid, seq: event.seq },
    );
  }
  return {
    promptId,
    state: state as PromptReceiptState,
    seq: event.seq,
    ts: event.ts,
  };
}

export function latestPromptReceipts(
  history: readonly ReadableEvent[],
): ReadonlyMap<string, PromptReceipt> {
  const receipts = new Map<string, PromptReceipt>();
  for (const event of history) {
    const receipt = promptReceipt(event);
    if (!receipt) continue;
    const previous = receipts.get(receipt.promptId);
    const validTransition = previous === undefined
      ? receipt.state === "prompt.intent"
      : previous.state === "prompt.intent"
        ? receipt.state !== "prompt.intent"
        : previous.state === "prompt.outcome_unknown"
          ? receipt.state === "prompt.unknown_acknowledged"
          : false;
    if (!validTransition) {
      throw new DispatchError(
        "session.prompt_receipt_invalid",
        `Session ${event.sid} contains an invalid prompt receipt transition at sequence ${event.seq}.`,
        {
          sid: event.sid,
          promptId: receipt.promptId,
          previousState: previous?.state ?? null,
          state: receipt.state,
          seq: event.seq,
        },
      );
    }
    receipts.set(receipt.promptId, receipt);
  }
  return receipts;
}

export function unresolvedPromptReceipt(
  history: readonly ReadableEvent[],
): UnresolvedPromptReceipt | undefined {
  const unresolved = [...latestPromptReceipts(history).values()].filter(
    (receipt): receipt is UnresolvedPromptReceipt =>
      receipt.state === "prompt.intent" ||
      receipt.state === "prompt.outcome_unknown",
  );
  if (unresolved.length > 1) {
    throw new DispatchError(
      "session.prompt_receipt_invalid",
      "Session contains more than one unresolved prompt operation.",
      {
        promptIds: unresolved.map((receipt) => receipt.promptId),
      },
    );
  }
  return unresolved[0];
}

export function assertNoUnresolvedPrompt(
  history: readonly ReadableEvent[],
  operation: string,
): void {
  const unresolved = unresolvedPromptReceipt(history);
  if (!unresolved) return;
  throw new DispatchError(
    "session.prompt_outcome_unresolved",
    `Prompt ${unresolved.promptId} is ${unresolved.state}; acknowledge it before ${operation}.`,
    {
      sid: history[0]?.sid ?? null,
      promptId: unresolved.promptId,
      state: unresolved.state,
      receiptSeq: unresolved.seq,
    },
  );
}
