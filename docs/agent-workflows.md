# Agent workflows

This guide is for an agent deciding whether repository work is new, already integrated,
discarded, or incomplete.

## Inspect work intelligence before acting

Ask Dispatch for the repository roadmap and related work before creating a session:

```sh
dsp work brief "<task intent>" --repo . --json
```

If the work already has a `wid`, confirm it is `planned` or `active` and has no
unresolved attempt, then start through that identity:

```sh
dsp new --work <wid> --json
```

For `blocked`, `review`, or `done`, inspect the item and explicitly reopen it to
`planned` or `active` only when that is the intended roadmap decision. `superseded` is
terminal; do not start it.

Do not create a second item to bypass a key, fingerprint, or active-attempt conflict.
Resolve the prior work or reservation explicitly. Lexical matches in the briefing are
search hints only; exact keys/fingerprints and recorded attempt reservations carry the
duplicate-prevention semantics.

A clean worktree removal without merge/discard evidence remains unresolved and blocks a
new attempt. The first slice has no automatic abandonment inference or reconciliation
command; surface that state instead of bypassing it with a second identity.

When no item exists, create a stable repository-scoped identity before starting:

```sh
dsp work create "<title>" --key <stable-key> --objective "<objective>" --repo . --json
```

Roadmap status is explicit. Do not infer `done` from a completed turn, clean diff, commit,
or merge. Candidate lessons can be attached without declaring them canonical:

```sh
Get-Content -Raw .\candidate-learning.txt |
  dsp work note <wid> --kind learning --session <sid> --stdin --json
```

Candidate insight bodies are local plaintext. Do not put credentials, private prompt
bodies, or raw provider transcripts in them.

## Inspect session history directly

List recent sessions as structured data:

```sh
dsp ls --limit 20 --json
```

Select sessions from the same repository, then read each relevant authoritative event
stream:

```sh
dsp log <sid> --json
```

Interpret outcomes conservatively:

- `outcome.recorded` with disposition `merged`, corroborated by `git.merged`, is
  known-integrated repository evidence.
- `removed` means the physical worktree was cleaned up. It does not negate an earlier
  merge.
- `git.discarded`, a discarded outcome, or a missing outcome is non-integrated or mixed
  evidence.
- `agent.started`, `turn.completed`, and similar lifecycle events do not prove the code
  integrated or the requested outcome occurred.
- Conflicting or multiple terminal receipts/outcomes are inconsistent. Do not claim
  integration or authorize a retry from them.

Use `tool.called`, `tool.result`, `git.merged`, and `outcome.recorded` to report what was
attempted, what integrated, and the observed turn and diffstat facts. Report cost only
when `usage.recorded` events exist. In alpha.3, `totalCost: 0` means no usage cost was
observed; it does not prove zero provider spend.

## Preserve the evidence boundary

- Treat each session's JSONL ledger as authoritative. SQLite is a disposable projection.
- If a session ledger reports corruption, stop and surface it. `dsp reindex` repairs the
  projection, not ledger data. For the global work ledger only, `dsp work repair` may
  remove an uncommitted non-newline tail; it refuses every committed corruption class.
- Do not read provider transcripts to reconstruct missing events.
- Do not treat `ext.<provider>` fields as canonical semantics.
- Do not turn a local session disposition into a production or customer-outcome claim.
- If no matching session exists, say so and continue from repository evidence.

The repository includes the same procedure as an agent skill at
[`skills/dispatch-history/SKILL.md`](../skills/dispatch-history/SKILL.md). The file is a
procedure, not an automatically installed integration.

For command shapes, filters, and repair behavior, see the
[CLI reference](cli-reference.md).
