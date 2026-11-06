# Developer Tools

Small local tools by **guenbankhai** for observing Claude Code and Codex sessions. They use Node.js built-ins and need no npm install, API keys, or build step.

## Included tools

| Tool | Purpose |
| --- | --- |
| Agent Monitor (`monitor.js`, `monitor/`) | Live terminal and web views of agent activity, hierarchy, token usage, and reported quota. |
| Quota snapshot (`quota.js`) | Print the current project's reported quota and session usage once. |

Project-specific Godot verification tools are not included.

## Requirements

- Node.js 20 or newer.
- Local Claude Code or Codex sessions and their transcript files.
- Git, when you want the monitor to discover related Git worktrees.

## Quick start

Keep this folder at a stable location. The examples below write its path as `<tools-folder>`; replace it with your own.

Install passive event recorders once per user:

```powershell
node <tools-folder>/monitor.js --setup
```

Setup updates Claude and Codex user hook configuration, preserves existing settings, and creates backups before changing files. Restart existing agent sessions so they load the hooks. Provider hook support and workspace trust still apply.

Start the monitor from the project you want to observe:

```powershell
cd <project-folder>
node <tools-folder>/monitor.js
```

One command starts the terminal and web together with one collector and shared logs. Open the URL shown in the terminal footer; the default is `http://127.0.0.1:4777`. If that port is occupied, the monitor chooses a free port and displays the actual URL. Only one monitor may record a given project at a time.

Other commands:

```powershell
# Print one terminal frame and exit without starting the web server.
node <tools-folder>/monitor.js <project-folder> --once

# Print a quota and session snapshot for the current project.
node <tools-folder>/quota.js

# Show CLI help.
node <tools-folder>/monitor.js --help
```

## Views and controls

- Press `q` or Ctrl+C to stop both views.
- Scroll the terminal with Up/Down, PageUp/PageDown, Home/End. Use Tab to select the tree or Completed table; each has its own scroll position.
- Switch the web tree between Horizontal and Vertical layouts.
- Running agents come first, then agents with higher cumulative token usage. Completed agents move into a separate table after remaining arrows finish. Unknown agents and Idle sessions without a reported model leave the tree immediately and occupy the final rows of the same table, preserving their source status and usage. Agents return to the tree when activity or model metadata becomes available. Sessions with only startup metadata (no turn, tool, assistant message, completion, or usage yet) stay hidden from the tree, table, and totals until real activity arrives. The table shows up to five rows before scrolling.
- Model colors identify agents. Gray links show ancestry. Directional arrows illustrate receiving/processing and returning messages/results; they are not network packets or message counts.
- Token bars show the mix of Input, Cache read, Cache write, and Output, rather than task progress. Counts are cumulative and can include repeated input. Missing source data stays Unavailable or Unknown; quota is only shown when reported by the provider.

## Configuration and logs

Edit `monitor/config.js`, then restart the monitor:

| Setting | Default | Meaning |
| --- | --- | --- |
| `LOG_PATH` | `''` | Log root; empty uses the terminal's current directory when launching the tool. |
| `WEB_IP` | `'127.0.0.1'` | Web server bind address. |
| `WEB_PORT` | `4777` | Preferred web server port. |
| `EFFECT_SPEED` | `1` | Positive arrow emission rate: 2 emits twice as often; 0.5 emits half as often. Travel time stays fixed. |

Logs always go in `<LOG_PATH or launch directory>/.log/monitor/`, including when an explicit project path is supplied:

- `events.jsonl`: append-only journal of observed events.
- `result.json`: atomically updated summary of sessions and usage.

New log timestamps use local date and time without a timezone suffix. Add `.log/monitor/` to the observed project's ignore rules when keeping logs there.

Environment overrides: `AGENT_MONITOR_HOME`, `CLAUDE_CONFIG_DIR`, and `CODEX_HOME`. Use matching values in the monitor and agent sessions.

## Quota sources

Claude quota works the same in the CLI and VS Code: the monitor reads the OAuth token in `~/.claude/.credentials.json` and calls Anthropic's usage endpoint (the one `/usage` uses), sending the token only to `api.anthropic.com`. Results are cached in `~/.agent-monitor/quotas/claude-usage.json`, shared by every monitor and `quota.js`, with at most one request every 3 minutes (10 after a 429). The token is never refreshed or copied; an expired token or missing login shows a warning. The endpoint is undocumented, so failures keep the last valid reading with its age, and a window missing from a newer reply is kept until its reset time. Values above 100% show as 100%. Quota for a provider is shown, and Claude's endpoint called, only while that provider has an agent in the tree. The web shows one line per provider and wraps to one line per window when narrow; the terminal always uses one line per window.

Codex quota comes from its session logs; rate-limit records without windows (such as the `premium` bucket logged near a limit) are ignored. Older setups installed a quota status line; running `--setup` again removes it and restores your original status line.

## Data handling and limits

The monitor reads local transcripts and passive recorder events. It does not start model requests, issue agent instructions, or modify original transcripts; its only network request is the Claude usage lookup. Logs can contain project paths, tool commands, status, and usage metadata; full prompts, file bodies, and successful tool-output bodies are not copied into the monitor journal.

Source formats and provider reporting determine coverage. A silent transcript does not prove that an agent is thinking or waiting. Token counts are not billing estimates or unique context size. Cloud, WSL, SSH, and container sessions are outside the supported local workflow.

## License

[MIT](LICENSE), copyright 2026 guenbankhai.
