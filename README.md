# Dispatch

Durable work sessions for coding agents.

Dispatch gives each task its own Git worktree and session ID. It records structured
agent activity in an append-only ledger, keeps fast session views in a rebuildable
index, and gives humans and agents one history to inspect before work is repeated.

Dispatch does **not** launch or run a model. It owns the worktree, session, evidence, and
optional retained-terminal lifecycle around an agent you start.

> [!WARNING]
> Dispatch `v0.2.0-alpha.3` is prerelease software. Windows x64 is the primary target;
> Linux x64 is secondary. Retained terminals and stdin-only prompt transport are an alpha
> Windows integration and require Herdr protocol `18`. See [project status](docs/project-status.md)
> for the exact proof boundary and open gates.

## For agents

Check prior Dispatch work before starting or repeating a task:

```sh
dsp ls --limit 20 --json
dsp log <sid> --json
```

The JSONL event ledger is authoritative. A recorded `merged` outcome corroborated by
`git.merged` is evidence that work integrated; agent lifecycle events alone are not.
Follow the repository's [Dispatch history procedure](skills/dispatch-history/SKILL.md)
for the complete interpretation contract.

## Start a session

Run from an existing Git repository with a local branch and at least one commit:

```sh
# Optional, once: observe Claude Code activity in future Dispatch worktrees.
dsp hooks install claude

# Dispatch prints the new session ID and worktree path.
dsp new "auth refactor" --json

# Start the agent yourself inside the returned worktree, then commit its work.
dsp log <sid> --json
dsp merge <sid>
dsp remove <sid>
```

On Windows, Herdr can retain and refocus the task terminal:

Continue only when `dsp doctor --stage1` exits `0` (or its JSON form reports
`readyForStage1: true`).

```powershell
dsp doctor --stage1
dsp open <sid>

# After you start an agent and Herdr reports it idle:
Get-Content -Raw .\prompt.txt | dsp prompt <sid> --stdin

dsp status <sid>
dsp close <sid>
```

`open` creates or focuses the terminal; it does not start an agent. Prompt acceptance
means Herdr queued the text and scheduled Enter—not that the agent consumed it or
completed the task. See [Windows agent sessions](docs/windows-agent-sessions.md).
After closing the terminal, return to the clean primary repository and run `dsp merge`
before `dsp remove`; removal alone does not integrate committed work.

## Install

The release binary embeds Bun. Git must be on `PATH`.
Choose the executable's final location before installing Claude hooks; the installer
records its absolute path. If you move the binary later, rerun `dsp hooks install claude`.

```powershell
Invoke-WebRequest `
  https://github.com/smithdak/dispatch/releases/download/v0.2.0-alpha.3/dsp-windows-x64.exe `
  -OutFile dsp.exe

.\dsp.exe --version
.\dsp.exe doctor
```

Linux x64, checksums, PATH setup, and the full first-session walkthrough are in
[Getting started](docs/getting-started.md).

## What Dispatch owns

- **Isolation:** one linked Git worktree and branch per task.
- **Memory:** one durable session identity with an append-only event history.
- **Lifecycle:** explicit create, inspect, merge, close, and remove operations.
- **Windows terminal control:** one receipted Herdr target, with explicit recovery after
  a witnessed server restart and stdin-only prompting to an idle foreground agent.

## Documentation

| I want to… | Read |
| --- | --- |
| complete my first isolated session | [Getting started](docs/getting-started.md) |
| let an agent inspect prior work | [Agent workflows](docs/agent-workflows.md) |
| operate or recover a Windows agent terminal | [Windows agent sessions](docs/windows-agent-sessions.md) |
| connect Claude Code | [Claude Code integration](docs/claude-code.md) |
| look up commands or state | [CLI reference](docs/cli-reference.md) · [Configuration](docs/configuration.md) |
| understand or develop the system | [Architecture](arch.md) · [Development](docs/development.md) |
| assess maturity and proof | [Project status](docs/project-status.md) · [Qualification evidence](docs/qualification/README.md) |

Start from the [documentation index](docs/README.md) for the full map.

## Develop

Source development requires Bun `1.3.14`:

```sh
bun install --frozen-lockfile
bun run check
bun run build
bun run qualify:binary
```

See [Development](docs/development.md) for the repository map, test layers, build matrix,
and qualification commands.
