# ADR 0005 — Private Herdr prompting is receipt-first and non-retriable when uncertain

- Status: accepted for the Stage 1 Windows alpha; clean local qualification passed at
  `dbcbac2`, exact-release synthetic transport qualification passed at `421efef`, and
  real-provider prompt consumption and turn completion passed once through recovered
  local evidence on 2026-08-01; named-pipe ACL qualification pending
- Date: 2026-07-31
- Scope: private prompt input, Herdr socket transport, concurrency, and outcome receipts
- As-of basis: Herdr `0.7.5-preview.2026-07-29-44b3adb12552`, protocol `18`,
  pinned source commit `44b3adb12552`, the installed protocol schema, and live native
  prompt qualification of the exact `v0.2.0-alpha.3` Windows asset built by Bun `1.3.14`

## Context

Herdr's high-level command accepts prompt text only as a positional argument:
`herdr agent prompt <target> <text>`. On Windows that exposes the body in process argv
and potentially in shell history. `pane send-input` can use the socket but is
occupant-blind. Neither surface supplies Dispatch's required combination of prompt
privacy, agent awareness, durable intent, and fail-closed retry semantics.

Protocol `18` exposes `agent.prompt` as one newline-delimited JSON request over the
Herdr local socket. On Windows, Herdr's logical socket path maps to a local named pipe by
prefixing `\\.\pipe\`. The request accepts a target and text but has no conditional
workspace, pane, terminal-generation, server-incarnation, or idempotency field.
Correlation IDs are not deduplication keys.

The crux is an ambiguous response. Once Dispatch attempts the pipe write, a disconnect
cannot establish whether Herdr rejected, queued, or scheduled the prompt. Retrying could
submit the same prompt twice or send it to a replacement terminal generation.

## Decision

`dsp prompt <sid> --stdin` is the only submission surface. It rejects prompt bodies in
positionals and option values, and it rejects interactive TTY stdin. The first alpha
boundary accepts only an idle Herdr agent, one line of valid UTF-8 without terminal
control characters, and at most 128 KiB. One terminal line ending introduced by a pipe
is removed before validation.

Dispatch submits one raw request on one new pipe connection:

```json
{"id":"<prompt-id>","method":"agent.prompt","params":{"target":"<pane-id>","text":"<ephemeral>"}}
```

The mutating request deliberately omits Herdr's `wait` parameter. A successful response
means Herdr accepted the request and queued text plus a scheduled Enter; it does not
prove PTY consumption, model acceptance, turn completion, or response correctness.
Waiting remains a separate read-only observation problem.

Before the socket call, Dispatch checks the full V2 target and records an
`agent.state` event with `operation: prompt` and `state: prompt.intent`. After the call it
records exactly one of:

- `prompt.accepted` for a correlated `agent_prompted` response whose returned agent
  matches the receipted workspace, tab, pane, and terminal generation;
- `prompt.rejected` for a trustworthy pre-write failure or one of the pinned Herdr
  zero-write errors (`empty_agent_prompt`, `agent_not_ready`, or
  `agent_prompt_failed`);
- `prompt.outcome_unknown` for any post-write transport failure, malformed response, or
  mismatched agent receipt. Structured errors are also unknown unless the pinned source
  proves that exact code occurs before terminal mutation; notably, `agent_not_found` and
  `server_unavailable` can be returned after text was enqueued.

The body, body hash, byte count, response content, and provider transcript are never
written to the Dispatch ledger or error details. A hash is excluded because short or
predictable prompts could be recovered by guessing and hashes create unnecessary
cross-session correlation.

Prompt operations serialize on a prompt-specific lock. The shared lifecycle lock is
held for target checks and ledger appends but released during the pipe request, allowing
provider hooks to record `turn.started` without deadlocking behind a lost response.
Open/focus, close, merge, remove, and later prompts fail closed while a prompt intent or
unknown outcome remains unresolved.

Dispatch never retries an uncertain prompt automatically. The operator must first use:

```powershell
dsp prompt <sid> --acknowledge-unknown <prompt-id>
```

Acknowledgement records that the operator accepts possible duplication or omission; it
does not claim to discover the original outcome. The acknowledgement may be combined
with a new stdin submission, but is not required to be.

## Rejected alternatives

### Forward stdin to the Herdr CLI

The installed CLI has no stdin or file-body mode. Dispatch would have to place the body
back into argv, defeating the privacy boundary.

### Use `pane.send_input`

This keeps bytes out of argv and can combine text with Enter, but it does not require a
recognized foreground agent or return an agent identity receipt. It weakens the
application boundary from agent prompt to terminal injection.

### Include `wait` in the mutating request

Herdr sends the prompt before waiting. A timeout or disconnect during that wait makes a
successfully submitted prompt look ambiguous for longer and can delay provider hooks.
Separating submission acknowledgement from later state observation narrows the unknown
window.

### Retry with the same request ID

Protocol `18` does not durably deduplicate IDs. Reusing one is correlation, not exactly
once delivery.

## Consequences and residual risk

- Prompt text remains present transiently in Dispatch memory, pipe bytes, the terminal,
  and the provider conversation. This decision proves argv and Dispatch-ledger privacy,
  not secrecy from same-user processes or the provider.
- Herdr pane history must remain disabled for this qualification because it can persist
  prompt and output content.
- Herdr validates a foreground agent, but `agent.prompt` cannot condition the mutation on
  Dispatch's expected full target generation. The repeated immediate preflight and
  post-response identity check bound and detect some races; they do not eliminate the
  preflight-to-write TOCTOU or undo a misdirected prompt.
- Herdr schedules Enter for later and returns success without confirming physical
  delivery. The receipt is therefore named `accepted`, not `delivered` or `completed`.
- A separate nonce-isolated real-Claude qualification correlated one acceptance with one
  same-session `UserPromptSubmit`, one later `Stop`, and marker-observation control flow.
  That single recovered run does not change the general semantics of `prompt.accepted`.
- The Windows named-pipe ACL was not independently verified. No confidentiality claim is
  made against other processes running as the same user.
- Multiline prompts, working-agent steering, separate wait/reconciliation, concurrent
  generation-change stress, and sustained daily-driver proof remain open.
- If Herdr adds an stdin-safe conditional prompt endpoint with a server-incarnation
  fence, idempotency key, and delivery acknowledgement, Dispatch should prefer it and
  retire this protocol-specific residual.

## Qualification update — 2026-08-01

The sanitized recovered receipt
[`stage1-windows-real-claude-48070cd0.json`](../qualification/stage1-windows-real-claude-48070cd0.json)
records one isolated native Claude Code `2.1.220` prompt and completed turn using installed
Dispatch bytes whose SHA-256 matches the retained `v0.2.0-alpha.3` Windows asset digest.
The separate
[`cleanup receipt`](../qualification/stage1-windows-real-claude-cleanup-48070cd0.json)
records exact-project purge and non-forced removal of the worktree, nonce-owned Herdr
session, and qualification root.

This closes only the single-turn real-provider prompt-consumption and turn-completion
gate for those tested release-identical installed bytes. The receipt is recovered local
evidence: no direct final pane snapshot, raw ledger, provider transcript, or original
qualifier source blob is retained. Named-pipe ACL behavior and every other residual above
remain open.

Primary sources: [socket API](https://herdr.dev/docs/socket-api/),
[agent automation](https://herdr.dev/docs/agent-automation/),
[CLI reference](https://herdr.dev/docs/cli-reference/), and
[pinned Herdr source](https://github.com/ogulcancelik/herdr/tree/44b3adb12552).
