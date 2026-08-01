# Qualification evidence

Qualification records keep three evidence classes separate:

1. **Machine-local evidence** is emitted by `bun run benchmark:stage0` against one
   compiled binary and an isolated temporary state directory. It is reproducible on the
   same machine, but it is not CI or provider evidence.
2. **CI evidence** is a dated link to a completed remote run at an exact Git commit. A
   configured workflow is not evidence that the workflow ran.
3. **Live-provider evidence** is a real provider process invoking the installed hook.
   Fixture-backed stdin and operator reports are useful but are labelled as such; neither
   is silently promoted to independently retained runtime evidence.

## Release decision records

- [`stage0-release-2026-07-31.md`](stage0-release-2026-07-31.md) records the dated Stage 0
  release verdict, including the accepted performance exception and residual risks.
- [`stage0-release-template.md`](stage0-release-template.md) is the reusable evidence
  template for a future Stage 0 release candidate.

## Reproduce the local measurements

Use the pinned Bun version to build, qualify, and benchmark the host binary:

```powershell
bun run build
bun run qualify:binary
bun run benchmark:stage0 --output (Join-Path $env:TEMP "dispatch-stage0-evidence.json")
```

The benchmark constructs 500 valid session ledgers and projections outside the timed
region, then records 30 samples after five warm-up iterations for:

- fresh compiled-process startup: `dsp --version`;
- provider-facing append: `dsp hook claude`, including process startup, translation,
  resolution, ledger fsync, SQLite projection, and exit;
- the full 500-session command: `dsp ls --limit 500 --json`, including projection
  integrity checks and JSON serialization.

The output retains raw samples, median, p95, mean, extrema, binary SHA-256, embedded and
benchmark-harness Bun versions, Git state, host characteristics, and whether Codex
environment markers were present. Each sample launches a fresh process, but the script
does not flush operating-system image or filesystem caches. A sandboxed result is not an
unsandboxed operator-shell result. The architecture does not state whether its latency
targets apply to median, p95, or maximum, so the record reports all three comparisons and
does not invent a release statistic.

Use `--binary`, `--iterations`, `--warmup`, and `--sessions` to change the fixture. A
query run with any session count other than 500 deliberately receives no comparison to
the architecture's 500-session target.

## Retained 2026-07-31 evidence

- [`stage0-windows-2026-07-31.json`](stage0-windows-2026-07-31.json) is the
  clean-source, pinned-Bun baseline before the query-path repair. Its 500-session median
  was `2821.357 ms` because every normal list operation opened all 500 ledger tails.
- [`stage0-windows-post-query-2026-07-31.json`](stage0-windows-post-query-2026-07-31.json)
  measures the projection-fast implementation. Its 500-session median was `96.869 ms`,
  a `29.12x` reduction; authoritative O(session count) reconciliation remains available
  through `dsp ls --verify`.
- [`stage0-live-claude-windows-2026-07-31.json`](stage0-live-claude-windows-2026-07-31.json)
  retains the sanitized real-provider receipt. It records the installed binary digest,
  provider version and result, canonical hook event sequence, and clean worktree cleanup
  without retaining the prompt or provider transcript.

Both performance runs used Bun `1.3.14` for the harness and embedded binary in the same
Codex-managed Windows environment. They did not flush operating-system caches. The
post-repair result still misses the architecture's original `<50 ms` process-level query
target; cold start and durable hook append also miss their original targets. Stage 0 is
therefore a functional pass with a documented performance exception, not a performance
pass.

## Stage 1 native Windows lifecycle

`scripts/qualify-windows-mux.ts` drives separate compiled `dsp.exe` processes and one
explicit absolute `herdr.exe`. Every Dispatch child receives that same Herdr path through
`DISPATCH_HERDR_BIN`; the evidence hashes both executables before and after the run.

The harness reports one of four profiles: `open_status`, `external_recovery`,
`terminal_close`, or `full_lifecycle`. A generic `pass` means only that the selected
profile passed. `completeLifecycle: true` is possible only for `full_lifecycle`, which
requires both `--exercise-external-close` and `--close`, a fresh Dispatch session whose
preflight is `created` / `not_recorded`, protocol `18`, initial create-and-record,
idempotent cross-process open/status, recovery to a wholly new generation after an
external Herdr close, terminal close, and confirmed operator-focus restoration.

Run the full profile only against a disposable session:

```powershell
$created = .\dist\dsp.exe new "Stage 1 qualification" --repo (Get-Location).Path --json |
  ConvertFrom-Json
bun run scripts/qualify-windows-mux.ts --binary .\dist\dsp.exe `
  --herdr "C:\absolute\path\to\herdr.exe" --sid $created.sid `
  --exercise-external-close --close `
  --output (Join-Path $env:TEMP "dispatch-stage1-windows.json")
.\dist\dsp.exe remove $created.sid
```

Raw harness output retains local absolute paths and the disposable SID. Sanitize those
fields before committing evidence. The proof is native lifecycle evidence, not restart,
prompt-privacy, or daily-driver evidence. Herdr has no atomic snapshot fence between the
adapter's full-generation preflight and its subsequent workspace-ID close, so closed-ID
reuse stress remains an explicit alpha gate.

[`stage1-windows-herdr-2026-07-31.json`](stage1-windows-herdr-2026-07-31.json)
is the sanitized `full_lifecycle` receipt for clean source commit `fff1f98`. It binds the
local compiled candidate and exact Herdr client by SHA-256, retains the two-generation
external-close recovery sequence, and records focus/worktree/branch cleanup. It is not a
downloaded release-artifact, restart/resume, prompt, or daily-driver receipt.

[`stage1-release-runtime-evidence-004c0adf.json`](stage1-release-runtime-evidence-004c0adf.json)
is the sanitized receipt for the exact Windows artifact downloaded from successful main
[CI run 30671133260](https://github.com/smithdak/dispatch/actions/runs/30671133260)
at commit `004c0ad`. Those same bytes are attached to the
[`v0.2.0-alpha.1` prerelease](https://github.com/smithdak/dispatch/releases/tag/v0.2.0-alpha.1).
The receipt does not close the prompt, restart/resume, concurrent focus-change,
closed-workspace ID reuse, atomic snapshot fence, abrupt harness termination, or
sustained daily-driver gates.

## Stage 1 isolated Windows cold restart

`scripts/qualify-windows-restart.ts` qualifies recovery separately from the ordinary
lifecycle profile. It requires native Windows x64, Bun `1.3.14`, a clean Git source tree,
an explicit compiled binary, an explicit Herdr executable, a fresh Dispatch session, and
a running default Herdr session. The output path must be outside the source tree.

The supplied Herdr session prefix is only a prefix. The harness appends an internally
generated 128-bit nonce, proves that name absent, starts that isolated namespace, and
samples the default namespace/workspace/focus fingerprint before and throughout the
run. For each cycle it:

1. stops only the nonce-named server and confirms it is listed stopped;
2. confirms its socket API rejects a snapshot request;
3. starts the same named server and waits for protocol-18 readiness;
4. invokes `dsp open --recover-restored-terminal` only inside that witnessed recovery
   window;
5. verifies stable server/workspace/tab/pane/cwd identity, one new terminal ID, one
   ledger increment, linked `previousMuxTarget` provenance, and a fresh terminal command.

Normal `dsp open`, `status`, and `close` remain fail-closed on terminal rollover. The
recovery flag is explicit operator authority; the harness does not infer a restart from
shape alone. Cleanup deletes the named session only after Dispatch terminal-close proof.
If cleanup cannot close or prove absence, it stops and retains the session for diagnosis.

Reproduce against a disposable session:

```powershell
$created = .\dist\dsp.exe new "Stage 1 restart qualification" `
  --repo (Get-Location).Path --json | ConvertFrom-Json
bun run scripts/qualify-windows-restart.ts --binary .\dist\dsp.exe `
  --herdr "C:\absolute\path\to\herdr.exe" --sid $created.sid `
  --herdr-session-prefix dispatch-restart --cycles 5 `
  --output (Join-Path $env:TEMP "dispatch-stage1-restart.json")
.\dist\dsp.exe remove $created.sid
```

[`stage1-windows-restart-51943d74.json`](stage1-windows-restart-51943d74.json) is
the sanitized receipt for clean source commit `51943d74`. It binds the candidate binary,
qualifier, Herdr executable, source commit, and Bun runtime; records ledger sequences
`3` through `8` and hashed terminal generations; and confirms the disposable worktree,
branch, and named Herdr namespace were removed. It is local compiled-candidate evidence,
not downloaded release-artifact, prompt-privacy, continuous concurrent-mutation, native
agent-conversation restore, or daily-driver evidence.

[`stage1-release-runtime-evidence-43fb9766.json`](stage1-release-runtime-evidence-43fb9766.json)
is the sanitized receipt for the exact Windows artifact downloaded from successful main
[CI run 30677442194](https://github.com/smithdak/dispatch/actions/runs/30677442194)
at merge commit `43fb976`. The same bytes are attached to the
[`v0.2.0-alpha.2` prerelease](https://github.com/smithdak/dispatch/releases/tag/v0.2.0-alpha.2).
It closes the exact-artifact five-cycle restart gate, not prompt privacy, native agent
conversation restore, concurrent focus-change or closed-ID reuse stress, an atomic
full-generation mutation fence, or sustained daily-driver proof.

## Stage 1 isolated Windows private prompt

`scripts/qualify-windows-prompt.ts` requires native Windows x64, Bun `1.3.14`, a clean
source HEAD, an explicit compiled `0.2.0-alpha.3` binary, an explicit Herdr executable,
and a raw output path outside the source tree. It refuses dirty tracked or untracked
source before allocating temp state or addressing Herdr, then proves the same HEAD,
branch, clean status, and executable hashes after cleanup.

The harness creates a nonce-named Herdr session with an isolated validated
`pane_history = false` configuration and a disposable Git repository, Dispatch home,
worktree root, and user/temp environment. It compiles a temporary native executable named
`codex.exe`, waits until that exact foreground process is ready, and reports it as an idle
Codex-kind agent. The helper decodes a generated marker only after receiving
`QUALIFY <base64>` through the compiled candidate's stdin. This exercises Herdr's actual
foreground-process check without invoking OpenAI Codex or another model.

The run passes only if the marker appears in pane output; the raw ledger contains exactly
one `prompt.intent` and one `prompt.accepted`; no prompt body, marker, hash, or length is
retained; every child argv and candidate environment is private-value-free; and the
agent, terminal, worktree, named session, and temporary files are all removed.

Reproduce from a clean source commit:

```powershell
bun run scripts/qualify-windows-prompt.ts `
  --binary .\dist\dsp.exe `
  --herdr "C:\absolute\path\to\herdr.exe" `
  --output (Join-Path $env:TEMP "dispatch-stage1-prompt.json")
```

[`stage1-windows-prompt-dbcbac21.json`](stage1-windows-prompt-dbcbac21.json) is the
sanitized receipt for clean source commit `dbcbac2`. It binds the local binary, qualifier,
Bun runtime, Herdr executable, and disposable native helper by SHA-256; records the
stdin/argv/environment/ledger privacy assertions; and confirms complete cleanup. It is
local compiled-candidate evidence, not downloaded release-artifact, genuine Codex,
provider-turn completion, multiline, concurrent target-rollover, named-pipe ACL, or
sustained daily-driver evidence.

[`stage1-release-runtime-evidence-421efef6.json`](stage1-release-runtime-evidence-421efef6.json)
is the sanitized receipt for the exact Windows asset from successful main
[CI run 30707951490](https://github.com/smithdak/dispatch/actions/runs/30707951490)
at commit `421efef`. The asset was uploaded to the draft release, downloaded back from
GitHub, matched byte-for-byte with the executable extracted from the Actions artifact,
and passed the same isolated private-prompt profile before the draft was published as the
[`v0.2.0-alpha.3` prerelease](https://github.com/smithdak/dispatch/releases/tag/v0.2.0-alpha.3).
The release retains the Windows and Linux executables, SHA-256 manifest, and this exact
receipt. This closes the exact-release synthetic transport gate, not genuine Codex or
provider-turn behavior, multiline input, concurrent target rollover, named-pipe ACL, or
sustained daily-driver evidence.

The retained receipt's `releaseDownloadByteIdenticalToActionsArtifact` field means that
the downloaded release executable matched the executable extracted from the Actions ZIP.
It does not compare the executable bytes with the ZIP archive bytes. The repository copy
is intentionally unchanged so its SHA-256 remains identical to the published receipt.

## Stage 1 isolated Windows real Claude prompt

[`stage1-windows-real-claude-48070cd0.json`](stage1-windows-real-claude-48070cd0.json)
is the normalized sanitized derivative of the recovered local receipt for one nonce-
isolated native Windows turn on 2026-08-01 using Claude Code `2.1.220`. The installed
`dsp.exe` SHA-256 matches the Windows executable digest retained for `v0.2.0-alpha.3`.
The recovered receipt records one prompt intent and acceptance, one post-baseline
`UserPromptSubmit`, one later `Stop` for the same provider session, nonempty completed-
turn output, zero tool calls, a clean unchanged worktree, and terminal closure. It also
records that the qualifier observed its constructed marker before entering the post-
proof close path; that marker observation is not independently re-evaluable from the
retained artifacts.

The qualifier did not emit its ordinary success receipt because Claude rewrote its
project config during graceful shutdown after the first purge. Cleanup recovery later
reconstructed the off-repository source receipt, and this derivative binds to it by
SHA-256. It explicitly records that no direct final pane snapshot, raw ledger, prompt,
response, provider transcript, debug log, or original qualifier source blob is retained.
It is recovered local live-provider evidence, not an ordinary independently retained
success receipt and not proof that the downloaded release-asset file itself was invoked.

[`stage1-windows-real-claude-cleanup-48070cd0.json`](stage1-windows-real-claude-cleanup-48070cd0.json)
records exact-project purge, non-forced worktree removal, nonce-owned Herdr-session
deletion, and qualification-root removal without unknown-outcome acknowledgement or
restored-terminal recovery.

Together these receipts close only the single-turn real-Claude prompt-consumption and
turn-completion gate for the tested release-identical installed bytes. They do not make
`prompt.accepted` a general delivery or completion guarantee and do not qualify
named-pipe ACLs or same-user confidentiality, multiline prompts, working-agent steering,
concurrent target-generation or closed-ID reuse, native conversation restore, other
providers, response quality, or sustained daily-driver use.
