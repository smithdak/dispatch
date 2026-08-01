# Windows agent sessions

Dispatch's Windows terminal integration gives an existing Dispatch session one retained
Herdr target. It can create or refocus that terminal, report its state, submit an
stdin-only prompt to an idle foreground agent, and close the target explicitly.

Dispatch does not start the agent. Herdr is an external retained-terminal runtime, not a
Dispatch daemon or provider integration.

## Prerequisites

You need:

- native Windows x64;
- an active Dispatch session created with `dsp new`;
- a running Herdr server compatible with protocol `18`; and
- the compiled `dsp.exe` binary.

Verify Stage 0 plus the Herdr dependency:

```powershell
dsp doctor --stage1
```

Proceed only when the command exits `0`. For scripts, use `--json` and require
`readyForStage1: true`; a printed Herdr `WARN` means Stage 1 is not ready.

If Herdr is not on `PATH`, set `DISPATCH_HERDR_BIN` to the absolute `herdr.exe` path for
the invocation. Use `DISPATCH_HERDR_SESSION` to select a named server session. The
default is `default`. See [Configuration and state](configuration.md).

## Open, inspect, and refocus

```powershell
dsp open <sid>
dsp status <sid>
dsp open <sid>
```

The first `open` creates a Herdr workspace at the Dispatch worktree if no valid target
exists. A later `open` focuses the same receipted target; it does not duplicate it.
Start Claude Code, Codex, or another supported foreground agent yourself inside that
terminal.

`status` is read-only. It reports the durable Dispatch lifecycle separately from the
live terminal and agent state.

Dispatch identities do not depend on Herdr display numbers. A V2 receipt binds the
server name and absolute socket plus the workspace, tab, pane, terminal generation, and
canonical cwd. Dispatch reuses that exact target while it exists. If it is confirmed
absent, Dispatch can reconcile one target with the deterministic `dispatch:<sid>` label
and canonical worktree path. Ambiguous matches fail closed.

## Submit a prompt

Prompting requires the receipted target to contain an idle foreground agent:

```powershell
Get-Content -Raw .\prompt.txt | dsp prompt <sid> --stdin
```

The alpha contract is narrow:

- piped stdin only—interactive TTY input and prompt bodies in arguments are rejected;
- one UTF-8 line after removal of one terminal CRLF or LF;
- no terminal control characters; and
- at most 128 KiB.

Dispatch sends the body over the receipted Herdr server's Windows named pipe. It does not
forward the body through `herdr agent prompt`, process argv, or the event ledger. The
ledger records body-free intent and accepted, rejected, or unknown receipts; it stores no
body, hash, or length.

An accepted receipt means Herdr queued the text and scheduled Enter. It does not prove
that the agent consumed the prompt, completed a turn, or produced the requested outcome.
The exact release qualification used a disposable native line-reader, not a real provider
or model. It did not independently verify the Windows named-pipe ACL, so it makes no
confidentiality claim against other processes running as the same user.

### Resolve an unknown outcome

After an uncertain post-write failure or a mismatched acknowledgement, Dispatch records
the prompt outcome as unknown. It will not retry automatically. Later prompt, focus,
close, merge, and remove mutations remain blocked to prevent silent duplication.

Inspect the terminal independently. If you accept that the prompt may have been omitted
or duplicated, clear the barrier with the exact prompt ID:

```powershell
dsp prompt <sid> --acknowledge-unknown <prompt-id>
```

Acknowledgement records operator acceptance of uncertainty; it does not reconstruct the
missing outcome.

## Recover after a witnessed Herdr restart

A cold Herdr restart restores workspace, tab, pane, and cwd shape but replaces the pane
process and terminal ID. Normal `open`, `status`, and `close` treat that generation
change as an identity conflict.

Only after independently witnessing the server restart, authorize one matching restored
shape:

```powershell
dsp open <sid> --recover-restored-terminal
```

Dispatch requires exactly one server/workspace/tab/pane/cwd match with a different
terminal ID. It appends a `restored_terminal` receipt linking the old and new complete
targets before focusing the replacement. The flag is explicit authority, not automatic
restart detection.

The same authorization is available when the intended operation is close:

```powershell
dsp close <sid> --recover-restored-terminal
```

## Close the terminal, merge the work, and remove the worktree

These are separate operations. After committing the session work, close its terminal,
return to the clean primary repository on the recorded base branch, merge, and only then
remove the linked worktree:

```powershell
dsp close <sid>
dsp merge <sid>
dsp remove <sid>
```

`close` preflight-verifies the complete target generation, closes the opaque Herdr
workspace ID, and records a target-specific terminal-close receipt. It is idempotent
after a completed close, including when Herdr later becomes unavailable. A closed
terminal session cannot be reopened.

`remove` does not merge. It deletes the Git worktree and refuses dirty work unless
`--force` is explicit. Removing a clean, committed but unmerged worktree leaves its
commits on the session branch without recording a merged outcome.

Herdr does not provide an atomic snapshot fence between Dispatch's preflight and the
workspace mutation. Concurrent server-side ID reuse is therefore a documented alpha
risk, not an atomic-close guarantee.

For rationale, see [ADR 0003](decisions/0003-herdr-windows-orchestration.md),
[ADR 0004](decisions/0004-herdr-namespaces-and-restart-generations.md), and
[ADR 0005](decisions/0005-private-herdr-prompt-transport.md). For reproducible test
profiles and retained receipts, see [Qualification evidence](qualification/README.md).
