# Dispatch — Architecture Specification v0.2

**Revision scope:** supersedes v0.1's positioning. v0.1 specced a supervisor beside
existing tools. v0.2 specs a tool that **owns** the worktree and session lifecycle, having
established that the adjacent tools (workmux, herdr) do not cover the durable-history or
provisioning gaps. Stack and scaffolding rules from v0.1 survive; scope, subsystems, and
sequencing are rewritten.

**Spec date:** 2026-07-30
**Targets:** macOS (arm64, x64), Linux (x64, arm64). Windows deferred.
**As-of basis:** version pins verified 2026-07-30. See Appendix A.
**Working name:** `dispatch`, binary `dsp`. Unresolved — see O2.

---

## 0. Thesis

Dispatch is a **personal control plane for agentic work** that owns four things nobody
else owns together: session identity, the durable event ledger, copy-on-write worktree
provisioning, and orchestration across the tools that already work.

The positioning decision: **Dispatch competes on the two axes the incumbents left open,
and imitates them everywhere else.**

| Axis                  | Incumbent state                                     | Dispatch                                            |
| --------------------- | --------------------------------------------------- | --------------------------------------------------- |
| Durable history       | None. All four tools answer "what is happening now" | Append-only ledger; queryable by human and agent    |
| Worktree provisioning | Copy (slow) or symlink (fast, breaks on divergence) | Copy-on-write clone: fast _and_ divergence-safe     |
| Worktree lifecycle    | Solved well by workmux                              | Imitate — its README is a de-facto requirements doc |
| Mux orchestration     | Solved well by workmux/tmux                         | Imitate                                             |
| Agent state           | Solved via hooks (workmux) or heuristics (herdr)    | Imitate the hook approach; it is the accurate one   |
| Diff review           | Solved well by hunk / tuicr                         | Delegate — hand off, never rebuild                  |

Everything in rows 3–6 is deliberate reimplementation of known-good design, not invention.
Invention budget is spent only on rows 1–2 and on the identity model that joins them.

### Non-goals

Terminal emulation; a diff-review UI; accounts, cloud, or telemetry; an editor; a plugin
system before the schema is stable; Windows support in v1.

---

## 1. Design invariants

- **I1 — The ledger is authoritative; everything else is a projection.** JSONL event logs
  are the source of truth. The SQLite index, status views, and any cache are derived and
  must be fully rebuildable by replay. Deleting a projection is never data loss.

- **I2 — No daemon.** No long-lived supervisor. Hooks are short-lived processes that
  append and exit. The CLI is invoked and exits. Nothing to install as a service.

- **I3 — Structured ingestion only.** Agent state comes from hooks or SDK callbacks —
  never from parsing terminal output. If a provider offers no structured surface, it gets
  lifecycle events only and is honestly marked as degraded.

- **I4 — The canonical event schema is ours.** Adapters translate at the boundary.
  Provider-shaped data reaches the ledger only inside a namespaced `ext` field, never in
  the envelope or canonical payload.

- **I5 — Append-only and machine-scoped.** Records are never mutated in place; every
  record carries the producing machine's ID. Federation must be addable without migration.

- **I6 — Core is dependency-free.** Identity, ledger, provisioning, and worktree logic
  import nothing beyond the Bun standard library. Third-party dependencies live only in
  leaf adapters.

- **I7 — One artifact, assumed toolchain.** A single compiled binary. The machine is
  expected to provide `git` and `tmux`. This is a deliberate weakening of v0.1's
  "no prerequisites," accepted because the alternative is reimplementing tmux.

- **I8 — Provisioned worktrees never share mutable state.** Any provisioning strategy that
  could let a write in one worktree be observed by another is forbidden for that path.
  This constrains the copy-on-write work and outranks any performance goal.

---

## 2. Tech stack

Unchanged from v0.1 except where the new scope adds a row.

| Layer                      | Choice                           | Version (2026-07-30) | Replaces               |
| -------------------------- | -------------------------------- | -------------------- | ---------------------- |
| Runtime                    | Bun (pinned)                     | `1.3.14`             | Node + build toolchain |
| Distribution               | `bun build --compile --bytecode` | Bun-native           | pkg, nexe              |
| Process spawn              | `Bun.spawn`                      | Bun-native           | execa                  |
| Shell / git / fs ops       | Bun Shell (`$`)                  | Bun-native           | zx, simple-git, go-git |
| Ledger storage             | JSONL, hand-rolled writer        | —                    | any embedded DB        |
| Ledger index               | `bun:sqlite`                     | Bun-native           | better-sqlite3         |
| Config                     | TOML via Bun's native import     | Bun-native           | yaml, cosmiconfig      |
| Tests                      | `bun:test`                       | Bun-native           | vitest                 |
| Claude headless (optional) | `@anthropic-ai/claude-agent-sdk` | `0.3.220`            | subprocess parsing     |
| Multiplexer                | `tmux` (external)                | system               | in-process PTY         |
| Diff review                | `hunk` or `tuicr` (external)     | see O1               | building a review UI   |

**Performance note, stated honestly.** Bun is not the fast choice; it is the maintainable
choice. Cold start is ~10–20 ms compiled with bytecode versus ~3 ms for Rust — invisible
per invocation against a ~100 ms perception threshold. Binary size is ~60–100 MB versus
~10 MB, which is a real product-feel cost with no functional consequence. The performance
claims in this spec come from §5 (provisioning), not from the runtime. If the artifact size
becomes intolerable, that is a legitimate trigger to revisit — see §9.

Bun-specific surface stays confined to spawn, shell, and sqlite so a future port remains a
weekend rather than a rebuild.

---

## 3. Identity model

The join key is the whole product. This section is the one every other subsystem cites.

A **session** is one unit of agentic work. Its ID is generated locally with no
coordination (I2): a millisecond timestamp in base32 plus four random characters, giving
lexicographic sortability and collision-freedom.

```text
sid  01K9QF7M2P-x4tq
      │          └── random suffix
      └───────────── base32 ms timestamp, sorts chronologically
```

One session resolves to all five of these, and every subsystem addresses the others
through the session rather than through path guessing:

| Facet      | Value                         | Owner     |
| ---------- | ----------------------------- | --------- |
| Worktree   | absolute path                 | Dispatch  |
| Branch     | git ref                       | Dispatch  |
| Mux target | tmux `session:window`         | Dispatch  |
| Review     | `hunk --repo <worktree>`      | delegated |
| Ledger     | `sessions/<sid>/events.jsonl` | Dispatch  |

Resolution is bidirectional: given a cwd, Dispatch finds the session (walk up to worktree
root, look up by path in the index); given a session, it finds everything else. Hooks fire
with only a cwd, so **path-to-session lookup is the hot path** and must be index-backed.

---

## 4. Event schema

The original design work in this spec. Strict on our own surface, tolerant of others'.

### Envelope

Every record is one JSON object on one line. Envelope fields are fixed; unknown envelope
fields are a validation error on write and are preserved on read.

```json
{
  "v": 1,
  "id": "01K9QF7M3A-b8kw",
  "sid": "01K9QF7M2P-x4tq",
  "mid": "wkst-dak-01",
  "seq": 42,
  "ts": "2026-07-30T15:04:05.123Z",
  "src": "hook",
  "kind": "tool.called",
  "data": { "name": "Edit", "path": "src/index.ts" },
  "ext": { "claude": { "tool_use_id": "toolu_01ABC" } }
}
```

- `src` is provenance: `hook`, `sdk`, `dsp`, or `user`. Never inferred.
- `seq` is monotonic per session; gaps mean lost events and are detectable.
- `ext` is namespaced by provider and is the **only** place vendor-shaped data may live (I4).

### Canonical kinds

Closed set. Adding a kind is a schema version bump; adding a field to `data` is not.

| Group      | Kinds                                                          |
| ---------- | -------------------------------------------------------------- |
| Session    | `session.created`, `session.opened`, `session.closed`          |
| Worktree   | `worktree.created`, `worktree.provisioned`, `worktree.removed` |
| Agent      | `agent.started`, `agent.stopped`, `agent.state`                |
| Turn       | `turn.started`, `turn.completed`                               |
| Tool       | `tool.called`, `tool.result`                                   |
| Permission | `permission.requested`, `permission.decided`                   |
| Usage      | `usage.recorded`                                               |
| Review     | `review.opened`, `review.commented`, `review.completed`        |
| Git        | `git.committed`, `git.merged`, `git.discarded`                 |
| Outcome    | `outcome.recorded`                                             |

`outcome.recorded` is the row that makes the ledger worth keeping: disposition
(merged / discarded / abandoned), diffstat, wall duration, total cost, turn count. It is
what answers "was this session worth running," and no other tool in this space records it.

### Storage and projection

```text
$XDG_STATE_HOME/dispatch/
├── machine-id
├── index.sqlite                  # derived projection — rebuildable, deletable (I1)
└── sessions/
    └── <sid>/
        ├── meta.json             # immutable facts: repo, branch, worktree, created-at
        └── events.jsonl          # authoritative append-only log (I1, I5)
```

The index carries only what queries need — session row, path lookup, cost and outcome
rollups. `dsp reindex` rebuilds it from JSONL. Because writes are appends and the index is
derived, a crashed hook can lose at most its own event and never corrupt state.

### Agent-queryable history

The ledger is exposed to agents, not just to you, via a skill plus a read-only
query command. A coordinator agent asking _"what did the last three attempts at this
module do, and which merged"_ is the capability this whole design exists to enable, and it
is downstream of nothing else on the market.

---

## 5. Provisioning engine

The performance story. Every competing tool either copies gitignored artifacts (correct,
slow) or symlinks them (fast, silently wrong once branches diverge). Copy-on-write is
both correct and fast, and nobody in this space uses it.

### Strategy ladder

Per configured path, first viable strategy wins. Filesystem capability is probed once and
cached.

| Strategy   | Mechanism                       | When                               | Divergence-safe                  |
| ---------- | ------------------------------- | ---------------------------------- | -------------------------------- |
| `clone`    | `clonefile(2)` / `cp --reflink` | APFS, btrfs, XFS-reflink, bcachefs | Yes — writes fork blocks         |
| `hardlink` | link farm                       | immutable content stores only      | Only if never rewritten in place |
| `copy`     | plain copy                      | any filesystem                     | Yes                              |
| `symlink`  | symlink                         | explicit opt-in only               | **No** — flagged as unsafe       |
| `command`  | run installer                   | no artifact to reuse               | Yes                              |

`hardlink` is forbidden for any path a tool rewrites in place (I8). Rust's `target/` and
most build caches disqualify themselves; content-addressed stores qualify.

### Lockfile-keyed template cache

The larger idea, and the one that compounds. Rather than cloning from the main worktree,
Dispatch maintains a dependency template keyed by lockfile hash:

```text
~/.cache/dispatch/templates/<lockfile-sha256>/
```

A new worktree clones from the template. Two consequences: the second worktree on a given
lockfile provisions in near-zero time, and **worktrees across different repositories sharing
a lockfile hit the same template**. Cache eviction is LRU by size cap.

### Budget

Targets, to be measured rather than assumed. Wide error bars until the spike lands.

| Operation                                              | Target               | Baseline today           |
| ------------------------------------------------------ | -------------------- | ------------------------ |
| `dsp new` → usable worktree, warm template, reflink FS | < 1 s                | 30–120 s (`npm install`) |
| `dsp new`, cold template                               | install time + < 1 s | same                     |
| CLI cold start                                         | < 25 ms              | —                        |
| `dsp ls`, 500 sessions                                 | < 50 ms              | —                        |
| Hook append                                            | < 5 ms               | —                        |

**This section is the highest-risk part of the spec** and is gated by a spike before any
code is written against it — see O3. ext4 has no reflink support, which is the common
Linux case and forces a graceful, honest degradation rather than a silent one.

---

## 6. Repository scaffolding

Target state. Import direction is one-way: `core` imports nothing from the repo; adapters
and CLI import `core` and `ports`; nothing imports an adapter except the registry.

```text
dispatch/
├── src/
│   ├── core/                    # zero third-party deps (I6)
│   │   ├── identity/            #   sid generation, bidirectional resolution (§3)
│   │   ├── ledger/              #   append writer, replay, schema validation (§4)
│   │   ├── index/               #   sqlite projection, rebuildable (I1)
│   │   ├── provision/           #   strategy ladder, template cache (§5)
│   │   ├── worktree/            #   git worktree lifecycle
│   │   ├── config/              #   TOML load, global + project merge
│   │   └── paths/               #   XDG resolution, machine id
│   ├── ports/
│   │   ├── mux.ts               #   window/pane/status — tmux today, others later
│   │   ├── agent.ts             #   hook ingestion + optional headless drive
│   │   └── review.ts            #   open a review against a worktree
│   ├── adapters/
│   │   ├── tmux/                #   only importer of tmux specifics
│   │   ├── hooks/               #   per-provider hook installers + translators
│   │   ├── claude-sdk/          #   only importer of the Agent SDK; optional
│   │   └── review-hunk/         #   or review-tuicr, per O1
│   ├── cli/                     # command surface
│   └── hook/                    # tiny fast-path entry invoked by agent hooks
├── skills/
│   └── dispatch-history/        # agent-facing query skill (§4)
├── test/
│   ├── fixtures/                # recorded hook payloads per provider
│   └── contract/                # one suite, every adapter runs it
├── scripts/
│   ├── build.ts                 # cross-target compile matrix
│   └── probe.ts                 # filesystem + provider capability probe
└── docs/
    ├── architecture/            # this spec, versioned
    └── decisions/               # ADR register
```

`src/hook/` is deliberately separate from `src/cli/` and compiled as its own entry point.
It runs on every tool call in every agent; it must do nothing but resolve a session and
append a line. Coupling it to the full CLI's import graph would put startup cost on the
hottest path in the system.

---

## 7. Sequencing

Ordered to reach daily-driver status fastest, because an undogfooded tool gets abandoned.

| Stage | Scope                                                                        | Exit threshold                                                                                 |
| ----- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **0** | Identity, worktree lifecycle, ledger, hook ingestion for Claude Code, CLI    | Create, list, merge, remove from commands; events land; `dsp log <sid>` replays a real session |
| **1** | tmux orchestration: layouts, panes, prompt injection, status in window names | Replaces workmux in daily use — this is the dogfood gate                                       |
| **2** | Provisioning engine: strategy ladder, template cache                         | Measured sub-second warm provision on APFS; honest degradation on ext4                         |
| **3** | Review handoff, `outcome.recorded`, query CLI, agent history skill           | An agent can query prior attempts and act on the answer                                        |
| **4** | Batch: worker pool, `--max-concurrent`, matrix prompts                       | Sequential and parallel task batches run unattended                                            |
| **5** | Additional hook adapters (Codex, OpenCode)                                   | Each passes the same contract suite from fixtures                                              |

**Re-evaluation triggers:** Bun tags `1.4`; the O3 spike fails; workmux ships a durable
ledger (reassess Stages 0–1 entirely); any provider breaks its hook contract.

---

## 8. Open decisions

| ID     | Decision                                             | Recommendation                                                                                                                                    | Resolved by                                                                                                                   | Severity                         |
| ------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **O1** | `hunk` vs `tuicr` for review handoff                 | hunk — session daemon is trivially drivable from Bun, `--repo` targeting matches §3; tuicr wins if pushing real GitHub PR reviews is in your loop | Your call; you have used both                                                                                                 | Medium                           |
| **O2** | Product and binary name                              | `dispatch`/`dsp` is a placeholder                                                                                                                 | Registry collision probe, per the `dakia` process                                                                             | Low                              |
| **O3** | Copy-on-write viability across target filesystems    | Assume viable on APFS and btrfs; unverified on XFS-reflink, bcachefs, ZFS block cloning; known absent on ext4                                     | **Spike before Stage 2**: clone a 500 MB `node_modules` on each target FS, verify divergence safety by writing in both copies | **High** — §5 is the perf thesis |
| **O4** | Headless execution: SDK-driven or hook-observed only | Hooks for v1; add the SDK path only if unattended runs need permission callbacks                                                                  | Stage 4 experience                                                                                                            | Medium                           |
| **O5** | Config merge semantics for global vs project         | Copy workmux's two-level model and its `"<global>"` include token; it is proven                                                                   | Stage 1                                                                                                                       | Low                              |
| **O6** | Schema evolution policy                              | New kinds bump `v`; new `data` fields do not; readers ignore unknown `data` fields and reject unknown envelope fields                             | Before Stage 0 ships                                                                                                          | Medium                           |

O3 is the only item that can invalidate a thesis. Resolve it before Stage 2, not during.

---

## 9. Kill / pivot triggers

1. **Stage 1 does not displace workmux within two weeks of use.** If you keep reaching for
   `workmux add`, the ownership premise is wrong — retreat to v0.1's companion scope and
   build only the ledger.
2. **O3 fails on your primary filesystem.** §5 collapses to "copy, but cached," which is
   an incremental gain over the incumbents rather than a differentiating one. Ship it
   anyway, but stop describing provisioning as the reason this tool exists.
3. **Binary size proves intolerable in daily use.** The runtime choice was made on
   maintenance grounds with performance neutral; if a ~10 MB artifact turns out to matter
   to you, the core is deliberately portable (I6) and Rust becomes correct.
4. **An incumbent ships a durable ledger.** Adopt it. The point is the capability, not
   authorship. Re-check at 90 days — this space produced two viable competitors during the
   drafting of this spec.

---

## Appendix A — Ground truth

Verified 2026-07-30 unless noted.

| Claim                                                   | Value                                                                         | Confidence               |
| ------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------ |
| Bun latest stable                                       | `1.3.14`                                                                      | High                     |
| Bun Rust rewrite merged, untagged ~6 weeks              | As of 2026-07-27                                                              | Moderate — single source |
| Bun native TOML import                                  | Supported                                                                     | Moderate                 |
| Agent SDK latest                                        | `0.3.220`                                                                     | High                     |
| Agent SDK supports `bun build --compile` via `/extract` | Documented in CHANGELOG                                                       | High                     |
| workmux                                                 | MIT, Rust, v0.1.211, 1,913 commits; hook-based agent status; no event ledger  | High                     |
| herdr                                                   | AGPL/commercial dual, Rust, v0.7.1; heuristic agent status; background server | High                     |
| hunk                                                    | Built on OpenTUI; loopback daemon; `hunk session`; `--repo` targeting         | Moderate                 |
| tuicr                                                   | MIT, Rust, `0.19.1`; JSON session store; `tuicr review` CLI                   | Moderate                 |
| APFS `clonefile` / Linux `cp --reflink`                 | Stable OS facts                                                               | High                     |
| ext4 lacks reflink                                      | Stable                                                                        | High                     |
| XFS / bcachefs / ZFS clone behavior                     | **Unverified**                                                                | **None — O3**            |
| All §5 performance targets                              | **Estimates, unmeasured**                                                     | Low                      |

### Volatility isolation

| Volatile surface             | Confined to                                 | Blast radius            |
| ---------------------------- | ------------------------------------------- | ----------------------- |
| Provider hook payload shapes | `adapters/hooks/<provider>/`                | One directory each      |
| Claude SDK API               | `adapters/claude-sdk/`                      | One directory, optional |
| tmux CLI behavior            | `adapters/tmux/`                            | One directory           |
| Review tool interface        | `adapters/review-*/`                        | One directory           |
| Filesystem clone syscalls    | `core/provision/`                           | One module              |
| Bun runtime APIs             | `core/provision`, `core/index`, spawn sites | Three modules           |
| git CLI behavior             | `core/worktree`                             | One module              |

---

_v0.2 — full-ownership scope locked. Next revision: CLI command surface and the tmux
adapter contract, written against Stage 0–1 implementation experience rather than ahead
of it._
