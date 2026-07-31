# Stage 0 release qualification — YYYY-MM-DD

## Candidate identity

- Git commit: `<40-character SHA>`
- Git tree clean before measurement: `<yes | no>`
- Dispatch version: `<version>`
- Compiled binary SHA-256: `<digest>`
- Embedded Bun: `<version>`
- Benchmark harness Bun: `<version>`

## Machine-local Windows evidence

- Evidence file: `<repository-relative path or immutable attachment URL>`
- Platform: `<win32/x64 and Windows build>`
- Host: `<CPU and logical processor count>`
- Execution context: `<operator shell | managed sandbox; name it>`
- Filesystem/state location class: `<local NTFS/ReFS/etc.; no user-specific path>`
- Fixture: `<session count, warm-up count, measured count>`

| Contract | Target | Median | p95 | Maximum | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| Fresh compiled `dsp --version` process | `<25 ms` | `<ms>` | `<ms>` | `<ms>` | `<observed only; target statistic unspecified>` |
| Compiled `dsp hook claude` durable append | `<5 ms` | `<ms>` | `<ms>` | `<ms>` | `<observed only; target statistic unspecified>` |
| Compiled `dsp ls --limit 500 --json` | `<50 ms` | `<ms>` | `<ms>` | `<ms>` | `<observed only; target statistic unspecified>` |

Method limitations: `<state whether OS caches were flushed, whether endpoint protection
or a sandbox could add overhead, and whether the run is representative of the operator's
normal interactive shell>`.

## Remote CI evidence

- Evidence class: `remote CI`
- Run URL: `<immutable run URL>`
- Commit: `<40-character SHA; must equal candidate>`
- Conclusion: `<success | failure>`
- Windows job: `<job URL and result>`
- Linux job: `<job URL and result>`
- Windows artifact: `<name, digest or immutable artifact URL, retention constraint>`

Record facts observed from the completed run. Do not treat workflow configuration as
proof that a job or artifact ran.

## Live Claude Code evidence

- Evidence class: `<independently retained runtime evidence | operator-reported>`
- Observer: `<operator or automated collector>`
- Date: `<UTC timestamp or date>`
- Installed executable SHA-256: `<digest if observed>`
- Session ID: `<sanitized SID if retained>`
- Receipt: `<sanitized event kind/sequence and evidence path>`
- Result: `<hook resolved in generated worktree and appended | not established>`

Fixture-backed stdin is not a real Claude Code invocation. An operator report is not
independently retained runtime proof and must remain labelled as operator-reported.

## Release verdict

- Stage 0 functional verdict: `<pass | fail>`
- Performance verdict: `<targets met | targets missed | observation inconclusive>`
- Residual risks: `<specific unresolved items>`
- Release/tag decision: `<ship | hold; named decision owner>`
