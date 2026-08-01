# Getting started

This tutorial ends with one committed agent task merged into its base branch and its
temporary worktree removed.

## Before you begin

You need:

- Windows x64, the primary target, or Linux x64, the secondary target;
- Git on `PATH`;
- an existing Git repository on a local branch with at least one commit; and
- a clean primary worktree when you merge the session.

The compiled binaries embed Bun. Bun `1.3.14` is required only when developing from
source.

## 1. Install Dispatch

The commands below download the `v0.2.0-alpha.3` prerelease into the current directory.
Choose its final location before installing Claude hooks: the installer records the
executable's absolute path. If you move the binary later, rerun
`dsp hooks install claude` from its new location.

### Windows x64

```powershell
Invoke-WebRequest `
  https://github.com/smithdak/dispatch/releases/download/v0.2.0-alpha.3/dsp-windows-x64.exe `
  -OutFile dsp.exe

.\dsp.exe --version
.\dsp.exe doctor
```

### Linux x64

```sh
curl -fL \
  https://github.com/smithdak/dispatch/releases/download/v0.2.0-alpha.3/dsp-linux-x64 \
  -o dsp
chmod +x dsp

./dsp --version
./dsp doctor
```

The release also publishes
[`SHA256SUMS.txt`](https://github.com/smithdak/dispatch/releases/download/v0.2.0-alpha.3/SHA256SUMS.txt).
This guide uses `dsp` below; substitute `./dsp`, `.\dsp.exe`, or the absolute path if the
binary is not yet on `PATH`.

## 2. Connect Claude Code, if you use it

Install the structured hooks once at user scope:

```sh
dsp hooks install claude
```

Future Dispatch worktrees inherit that installation. Skip this step for other agents;
Claude Code is currently the only structured hook provider. Dispatch still manages the
worktree and session without provider hooks.

The installed hook points to the exact executable used for this command. Keep it there,
or rerun the installer after moving or replacing it.

See [Claude Code integration](claude-code.md) for project scope, source-mode setup, and
the data boundary.

## 3. Create the session

From the repository that will receive the final change:

```sh
dsp new "auth refactor" --json
```

The result includes a sortable `sid` and an absolute `worktreePath`. Keep the SID for
later commands, then change directory to the returned worktree.

## 4. Run the agent

Start Claude Code, Codex, or another agent yourself inside the worktree. Dispatch creates
the worktree and records the session; it does not launch the agent.

Make the change, verify it, and commit it on the session branch. Dispatch refuses to
merge uncommitted or dirty session work.

Windows users who want a retained Herdr terminal can follow
[Windows agent sessions](windows-agent-sessions.md) instead of changing directory
manually.

## 5. Inspect what happened

```sh
dsp ls
dsp log <sid>
```

Use JSON for agent or script consumption:

```sh
dsp ls --limit 20 --json
dsp log <sid> --json
```

`dsp ls` uses the rebuildable SQLite projection for its normal fast path. If you need to
compare every projected sequence with the authoritative ledger tail, run
`dsp ls --verify`. Use `dsp reindex` to rebuild the projection explicitly.

## 6. Merge and remove

Return to the primary repository. It must be clean and still checked out on the recorded
base branch:

```sh
dsp merge <sid>
dsp remove <sid>
```

`merge` records the session diffstat, wall duration, observed turn count, and any emitted
usage events before closing the logical session. Alpha.3's Claude adapter does not emit
`usage.recorded`; a recorded `totalCost` of `0` therefore means no usage cost was
observed, not that provider spend was zero. `remove` deletes the linked worktree. It
refuses a dirty worktree unless `--force` is explicit; a forced dirty removal is recorded
as a discard.

You now have one merged change and a durable event history that remains queryable after
the worktree is gone.

Next: [learn the agent history contract](agent-workflows.md) or use the
[CLI reference](cli-reference.md).
