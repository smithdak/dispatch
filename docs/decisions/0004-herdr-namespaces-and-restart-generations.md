# ADR 0004 — Herdr namespaces and restart generations require explicit authority

- Status: accepted for the Stage 1 Windows alpha
- Date: 2026-07-31
- Scope: Herdr server identity, alpha.1 receipt migration, and cold-restart recovery
- As-of basis: Herdr `0.7.5-preview.2026-07-29-44b3adb12552`, protocol `18`,
  native five-cycle observation on 2026-07-31, and
  [Herdr session-state documentation](https://herdr.dev/docs/session-state/)

## Context

The original receipt identified a Herdr workspace, tab, pane, terminal, protocol, and
cwd, but not the Herdr server namespace that issued those opaque IDs. Herdr supports a
default server and named sessions with separate sockets. Reusing the same backend IDs in
two servers would make a workspace-only comparison unsafe.

Native restart falsification also corrected the continuity model. Herdr cold restart
restores workspace/tab/pane IDs, cwd, layout, and focus from its snapshot, but the
original pane processes do not survive. The restored shell receives a new terminal ID.
Pane screen history is off by default and was not enabled because it can persist prompts,
tokens, commands, and output. Native agent conversation restore is a separate
integration-specific capability; terminal shape recovery does not prove it.

The crux is authorization. A matching server/workspace/tab/pane/cwd with a different
terminal ID is consistent with a cold restart, but it is also consistent with an
unrelated terminal replacement. Shape alone is not a restart witness.

## Decision

Mux target V2 adds a server namespace:

```text
server.session  named Herdr session, or null for default
server.socket   absolute socket or named-pipe path reported by the server
```

Every Herdr invocation is prefixed with the configured session. The adapter probes the
client and server session plus exact socket before target inspection or mutation.
`DISPATCH_HERDR_SESSION` selects the session and defaults to `default`.

V1 receipts remain readable. They may bind only to exactly one V2 candidate on the
current default server. A same-terminal match performs a conservative namespace
migration. A cold-restored V1 receipt requires the same explicit recovery authority as a
V2 receipt.

Normal `open`, `status`, and `close` fail closed when the recorded terminal ID conflicts.
`open` and `close` accept `--recover-restored-terminal` as an explicit authorization for
one narrow transition:

- backend, protocol, server namespace, workspace, tab, pane, and canonical cwd match;
- terminal ID differs;
- discovery yields exactly one such candidate.

Before focus or close, Dispatch appends a `session.opened` receipt with
`action: restored_terminal`, the new `muxTarget`, and the full `previousMuxTarget`.
Receipt append failure prevents the mutation. If reconnect fails after append, retry
uses the exact new receipt without duplicating the event.

The restart qualifier is allowed to pass that flag only after it has observed this
sequence for its isolated nonce-named server: listed running, stopped, listed stopped,
socket API rejection, restarted, and protocol-18 ready. Recovery authority is cleared
after the linked receipt is committed. Cleanup outside that window uses ordinary close
and retains state on conflict.

## Rejected alternatives

### Automatically adopt same-shape terminal rollover

This would make restart transparent, but it would convert any unrelated terminal
replacement into focus/close authority. That contradicts full-generation ownership and
becomes more dangerous when prompt targeting is added. Explicit authorization is the
smaller and safer contract.

### Rediscover by label and cwd after every restart

Label plus cwd are correlation fields, not identity. Replacing the full target would
discard the stable restored shape and weaken conflict detection. They remain appropriate
only when no receipt exists or a receipted target is confirmed absent.

### Treat socket path as a server-incarnation token

The named-session socket separates concurrent namespaces, but it remains stable across
restart. It does not prove a unique server incarnation or cryptographically exclude a
state reset followed by adversarial ID reuse.

## Consequences and residual risk

- The locally compiled alpha.2 candidate passed five isolated cold-restart cycles. Each
  cycle preserved workspace/tab/pane/cwd, advanced the terminal ID and ledger sequence
  exactly once, executed a fresh command, and retained linked transition provenance.
- Cold restart continuity means restored addressable workspace shape, not preservation of
  the original OS process, PID, screen history, or agent conversation.
- `status` is intentionally read-only and does not authorize rollover. After restart, an
  operator must explicitly recover before ordinary commands use the new generation.
- Herdr still accepts workspace IDs rather than a conditional full-target token for
  focus and close. The fresh preflight-to-mutation interval is a bounded TOCTOU residual.
- The qualifier's internally generated 128-bit session-name nonce makes accidental local
  collision negligible. Herdr exposes no serving-process ownership token, so a malicious
  local claimant is not cryptographically excluded.
- Prompt privacy, concurrent focus/change stress, closed-ID reuse stress, exact release
  artifact qualification, and sustained daily-driver proof remain open Stage 1 gates.
