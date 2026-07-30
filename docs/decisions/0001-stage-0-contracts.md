# ADR 0001 — Stage 0 executable contracts

- Status: accepted
- Date: 2026-07-30
- Scope: implementation choices needed to make `arch.md` v0.2 executable

## Context

The architecture intentionally defers the complete CLI surface, and it contains four
implementation ambiguities:

1. I7 requires one distributed artifact while §6 describes the hook as a separately
   compiled entry point.
2. §4 says unknown envelope fields are preserved on read while O6 recommends rejecting
   them.
3. The sketched four-character random ID suffix contains only 20 bits of entropy, which
   cannot support the stated collision-freedom or global SQLite uniqueness.
4. I1 calls JSONL authoritative while the storage diagram also introduces immutable
   `meta.json`.

Waiting for another architecture revision would block the Stage 0 dogfood loop.

## Decision

The Stage 0 command surface is:

```text
dsp new [name] [--repo <path>] [--base <ref>] [--branch <ref>] [--path <path>]
dsp ls [--limit <n>] [--status <status>] [--repo <path>] [--json]
dsp log <sid> [--kind <kind>] [--limit <n>] [--json]
dsp merge <sid>
dsp remove <sid> [--force]
dsp reindex
dsp hooks install claude [--project <path>] [--command <command>]
dsp hook claude
dsp doctor [--json]
```

`dsp hook claude` is routed lazily to a minimal module. `src/hook/main.ts` remains an
independent development and benchmark entry point, but the release contains one `dsp`
artifact. This resolves the conflict in favor of I7 without putting the full command
graph on the hook's runtime path.

`dsp hooks install claude` defaults to Claude user scope at
`~/.claude/settings.json`. This makes the structured hook available to future Dispatch
worktrees without repeating installation. The hook is safe at user scope because cwd
resolution ignores events outside Dispatch-owned worktrees. Supplying `--project <path>`
is an explicit project-local override at `.claude/settings.local.json`; it does not apply
to future sibling worktrees.

Canonical writes reject unknown envelope fields. Replay accepts and preserves them while
still validating every known field. This follows the explicit §4 compatibility rule;
changing replay to strict mode remains an O6 schema-policy decision.

Sortable IDs use the ten-character timestamp prefix plus sixteen Base32 random
characters (80 random bits). This deliberately corrects the four-character sketch while
preserving time ordering.

The newline is the JSONL commit marker. Replay reports and excludes a final
non-newline-terminated record, matching append recovery. Sequence-1 `session.created`
contains every immutable session fact; `meta.json` is reconstructed from that event when
missing or invalid. Reindex discovers session directories and starts from ledgers rather
than trusting metadata.

Removed worktree paths may be reused by a later session generation. SQLite retains both
histories and cwd resolution chooses the newest generation without a
`worktree.removed` event.

Global `config.toml` and repository `.dispatch.toml` use a strict two-level overlay for
Stage 0. The `"<global>"` include-token proposal remains deferred with O5.

## Consequences

- Hook installation can use one stable command: `dsp hook claude`.
- Default hook installation is inherited by future worktrees; explicit project-local
  installation is not.
- The distributed binary and the hook fast path do not diverge by version.
- Older readers do not destroy new envelope data during replay or reindex.
- Event and session IDs have 80 random bits rather than the unsafe 20-bit sketch.
- Deleting or corrupting `meta.json` does not lose a session when its ledger origin is
  intact.
- Historical path reuse does not redirect hooks into a removed session.
- CLI spelling is now compatibility surface and must change through a later ADR.
- Project configuration can override global values, but composition beyond two levels is
  deliberately unavailable.
