# Configuration and state

Dispatch keeps authoritative event history separate from disposable query state. Paths
are native to the host operating system unless an explicit environment override is set.

## State locations

`XDG_STATE_HOME`, when set, is honored on every platform unless `DISPATCH_HOME` is set.
Without either override, Windows uses:

```text
%LOCALAPPDATA%\dispatch\
├── machine-id
├── index.sqlite                 derived and disposable
├── sessions\
    └── <sid>\
        ├── meta.json            immutable, ledger-rebuildable facts projection
        └── events.jsonl         authoritative append-only ledger
└── intelligence\
    └── work\
        └── events.jsonl         authoritative work graph and attempt reservations
```

On Linux, state falls back to `~/.local/state/dispatch`. The default worktree root is
`$XDG_DATA_HOME/dispatch/worktrees`, falling back to
`~/.local/share/dispatch/worktrees`. `dsp doctor --json` reports the resolved state
directory inside its `state` check; it does not enumerate every Dispatch path.

The JSONL ledger is the source of truth. `index.sqlite` and session views can be rebuilt
with `dsp reindex`; ledger corruption cannot be repaired from the projection.

The work ledger is a separate authoritative stream because one work item can span several
sessions. It is replayed directly in the first intelligence slice and is not rebuilt or
repaired by `dsp reindex`. `dsp work repair` can discard only an uncommitted torn tail;
all committed corruption remains fail-closed.

Work titles, objectives, external references, and candidate insight bodies are stored as
local plaintext. The first slice has no secret redaction or retention policy, so these
fields must not contain credentials or raw provider transcripts.

## Configuration files

When `XDG_CONFIG_HOME` is set, global configuration lives at
`$XDG_CONFIG_HOME/dispatch/config.toml` on every platform. Otherwise it lives at:

- Windows: `%APPDATA%\dispatch\config.toml`
- Linux: `~/.config/dispatch/config.toml`

A repository can override global values with `.dispatch.toml` at its root.

```toml
[worktrees]
root = "D:\\worktrees\\dispatch"
branch_prefix = "dispatch/"

[ledger]
fsync = true
lock_timeout_ms = 2000
```

Configuration is strict. Unknown keys fail instead of silently accepting a typo.

| Setting | Built-in default |
| --- | --- |
| `worktrees.root` | `%LOCALAPPDATA%\dispatch\worktrees` on Windows; `$XDG_DATA_HOME/dispatch/worktrees` or `~/.local/share/dispatch/worktrees` on Linux |
| `worktrees.branch_prefix` | `dispatch/` |
| `ledger.fsync` | `true` |
| `ledger.lock_timeout_ms` | `2000` |

## Environment overrides

| Variable | Effect |
| --- | --- |
| `DISPATCH_HOME` | Override the complete Dispatch state directory. Intended for isolated development and tests. |
| `DISPATCH_WORKTREE_ROOT` | Override the configured linked-worktree root. |
| `DISPATCH_BRANCH_PREFIX` | Override the configured session-branch prefix. |
| `DISPATCH_HERDR_BIN` | Use an explicit absolute `herdr.exe` path for the Windows adapter. |
| `DISPATCH_HERDR_SESSION` | Select a named Herdr server session. Defaults to `default`. |
| `XDG_STATE_HOME` | Select the state base when `DISPATCH_HOME` is unset. Honored on every platform. |
| `XDG_CONFIG_HOME` | Select the global-config base. Honored on every platform. |
| `XDG_CACHE_HOME` | Select the cache base. Honored on every platform. |
| `XDG_DATA_HOME` | Select the default worktree-root base. Honored on every platform. |

A persisted V2 Herdr receipt must match the selected live server name and socket. Changing
`DISPATCH_HERDR_SESSION` does not retarget an existing receipt.

For TOML keys, precedence is built-in defaults, then global configuration, then the
repository's `.dispatch.toml`. `DISPATCH_WORKTREE_ROOT` and `DISPATCH_BRANCH_PREFIX`
override their corresponding merged values. `DISPATCH_HOME` changes only the state
directory; it does not move the config or cache directories.

For terminal operations, see [Windows agent sessions](windows-agent-sessions.md). For
system-level invariants, see the [architecture specification](../arch.md).
