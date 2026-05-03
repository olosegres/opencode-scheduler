# opencode-scheduler

Run AI agents on a schedule. Set up recurring tasks that execute autonomously—even when you're away.

```
Schedule a daily job at 9am to search Facebook Marketplace for posters under $100 and send the top 5 deals to my Telegram
```

This is an [OpenCode](https://opencode.ai) plugin that uses your OS's native scheduler (launchd on macOS, systemd on Linux, Task Scheduler on Windows), with cron fallback where native backends are unavailable.

As of `v1.2.0`, jobs are scoped by `workdir` (so different projects don't collide), and scheduled runs are supervised (no overlap + optional timeout).

## Install

Add to your `opencode.json`:

```json
{
  "plugin": ["opencode-scheduler"]
}
```

## Examples

**Daily deal hunting:**
```
Schedule a daily job at 9am to search for standing desks under $300
```

**Weekly reports:**
```
Schedule a job every Monday at 8am to summarize my GitHub notifications
```

**Recurring reminders:**
```
Schedule a job every 6 hours to check if my website is up and alert me on Slack if it's down
```

## Commands

| Command | Example |
|---------|---------|
| Schedule a job | `Schedule a daily job at 9am to...` |
| List jobs | `Show my scheduled jobs` |
| Get version | `Show scheduler version` |
| Install skill template | `Install the scheduled job best practices skill` |
| Get job | `Show details for standing-desk` |
| Update job | `Update standing-desk to run at 10am` |
| Run immediately | `Run the standing-desk job now` |
| View logs | `Show logs for standing-desk` |
| Delete | `Delete the standing-desk job` |
| Global cleanup (dry run) | `Run scheduler global cleanup` |

## How It Works

1. You describe what you want scheduled in natural language
2. The plugin writes a job file (scoped by `workdir`) and installs a timer in your OS scheduler
3. At the scheduled time, the OS scheduler calls a small supervisor script
4. The supervisor runs the job, appends logs, and updates job metadata

You can also trigger a job immediately via `run_job`—it runs fire-and-forget and appends to the same log file.

Jobs run from the working directory where you created them, picking up your `opencode.json` and MCP configurations.

### Reliability Guarantees (Scheduled Runs)

- **No overlap**: if the previous run is still active, the next scheduled tick is skipped.
- **Non-interactive by default**: scheduled runs force `OPENCODE_PERMISSION` to deny "question" prompts, so jobs don't hang waiting for approvals.
- **Optional timeout**: set `timeoutSeconds` to hard-stop long runs (SIGTERM, then SIGKILL).
- **Terminal env parity**: at schedule-time the plugin captures the full terminal env (PATH, MCP tokens, plugin secrets, locale) and persists it on the job. Scheduled runs see the same env as your interactive `opencode`. See [Env behavior](#env-behavior) for tuning and trust-boundary notes.

### Live HTTP delivery (live runner)

When a job is scheduled with `attachUrl` pointing at a reachable opencode server, the supervisor runs a small **runner** (`runner.js`) that delivers the prompt over HTTP instead of spawning a second `opencode run` process:

- preflight `/global/health` + `/session/<id>` (1.5s timeout)
- if the session is busy and `deliveryPolicy='execute'` (default), wait up to `timeoutSeconds` for it to go idle, then deliver
- if `deliveryPolicy='leave-message'`, deliver immediately with `noReply: true` so the user/agent picks the message up later
- on any HTTP/network failure (exit 10), the supervisor falls back to the headless `opencode run` invocation captured at schedule-time
- contract errors (session 404 etc.; exit 11) abort without falling back

Each fire-time attempt appends a structured record to `~/.config/opencode/scheduler/scopes/<scope>/runs/<slug>.jsonl` (delivery, attachUrl, sessionId, httpStatus, error, durationMs).

### Session policies

`schedule_job` REQUIRES `sessionPolicy` — there is no default. Always ask the user which one fits before scheduling; a silent default ('current') was the root cause of the "job ran but my TUI never refreshed" reproduction. `update_job` keeps the field optional (most updates change schedule/prompt, not policy).

| Policy | Behavior |
|--------|----------|
| `current` | Use the session that called `schedule_job`. Requires running from inside an opencode session, or `sessionId` passed explicitly. For live in-TUI delivery, the host opencode must be launched with `--port` (otherwise `serverUrl` is `http://opencode.internal/...` and the message lands in storage but the open TUI does not refresh until reopen — `schedule_job` warns when this happens). |
| `existing` | Use a session id you supply. Requires `sessionId`. |
| `new-per-job` | Create one dedicated session at schedule-time and reuse it for every run. The new session gets `question`/`plan_enter`/`plan_exit` denied permanently. |
| `new-per-run` | Create a fresh session at every fire (runner POSTs `/session` with the same deny rules). |

**Permission semantics** — `current` and `existing` inherit the chosen session's existing permission ruleset; the scheduler does NOT mutate it (no public PATCH route accepts permission changes). If you want strict no-questions, pick `new-per-job` or `new-per-run`. The headless fallback subprocess always gets `OPENCODE_PERMISSION={"question":"deny"}` via supervisor env.

`executionPolicy` controls live-vs-headless preference:

- `prefer-live-server` (default) — try live HTTP if `attachUrl` set, fall back to headless on failure.
- `headless-only` — never attempt live HTTP. Mutually exclusive with `attachUrl`.

`deliveryPolicy` controls busy handling on live delivery:

- `execute` (default) — wait for the session to go idle, then deliver.
- `leave-message` — deliver immediately with `noReply: true`; user resumes manually.

### Env behavior

At schedule-time, the plugin captures the **full terminal env** as a per-job snapshot, minus a small denylist (`OPENCODE_PERMISSION`, `OPENCODE_SCHEDULER_RUN_ID`, `OLDPWD`, `PWD`, `SHLVL`, `_`). The snapshot is written into `job.json`; the OS scheduler entry only gets the bootstrap env (`PATH`, `HOME`, `USER`, `SHELL`). `supervisor.pl` merges the full snapshot back into `%ENV` before exec.

This fixes the `env: node: No such file or directory` failure on hosts using NVM/asdf/mise/Volta/pnpm/Bun without baking only PATH; MCP/plugin tokens (`OPENCODE_API_KEY`, MCP server credentials, etc.) carry over too.

**Trust boundary** — the snapshot may contain secrets. It lives only under user-only files: `~/.config/opencode/scheduler/scopes/...`, `~/Library/LaunchAgents/...`, `~/.config/systemd/user/...`. We do not ship secrets across machines or users.

Override via `~/.config/opencode/opencode-scheduler.json`:

```json
{
  "env": {
    "mode": "snapshot",
    "exclude": ["MY_DEBUG_TOKEN"],
    "set":     { "OPENCODE_AUTO_SHARE": "1" }
  }
}
```

Modes:

- `snapshot` (default) — full `process.env` minus denylist + `exclude`.
- `minimal` — only `PATH`, `HOME`, `USER`, `SHELL`. Use when you want strict-env runs.
- `login-shell` — same snapshot capture as `snapshot`, plus the invocation is wrapped in `$SHELL -lic '...'` so your interactive shell rc files run before opencode does. Useful when PATH/env relies on a lazy initializer (e.g. NVM via `.zshrc`). Skipped on Windows.

Legacy keys `env.preserve` / `env.preserveOpencodeEnv` are accepted but ignored with a one-shot warning.

Jobs created on `v1.3.x` (no `env` field) fall back to `mode='minimal'` at supervisor time and print a one-line warning into the log telling you to recreate the job.

#### How env actually flows at fire-time

The OS scheduler entry (launchd plist / systemd unit / cron line) only sets the **bootstrap env** — `PATH`, `HOME`, `USER`, `SHELL`. Everything else (the full snapshot from `captureJobEnv`) lives in `job.json` under `env.snapshot` and is merged into `%ENV` by `supervisor.pl` before exec'ing the actual command.

Why two layers:

1. The bootstrap env exists so `/usr/bin/env node` can find Node and `/usr/bin/perl` can find `$HOME` for log paths. Tiny, no risk of bloating unit files or hitting cron line-length limits.
2. The full snapshot lives in `job.json` (already user-only) — single source of truth for runtime env. Editing `job.env.snapshot` re-takes effect on the next fire without rewriting the OS scheduler entry.

#### Shell selection (login-shell mode)

When `mode: 'login-shell'` is set, the captured invocation becomes `$SHELL -lic '<original-cmd>'`. We trust `$SHELL` from the terminal where you scheduled the job, with `/bin/bash` as a portable fallback (bash is universally available on macOS — even when default is zsh — and on every Linux). zsh is **not** assumed because minimal Linux server images often ship without it.

### Linux notes

**Backend preference**: on Linux the plugin uses `systemd --user` when available (every modern desktop distro and most server distros). Cron is the fallback for stripped-down environments without user systemd (some headless containers, NixOS, openrc-based distros).

**Cron line length**: historical `vixie-cron` had a ~1 KB per-line limit. The plugin emits only the bootstrap env (4 keys) inline; the rest comes from `job.env.snapshot` via supervisor.pl, so even with 100+ env vars the crontab line stays well under any limit.

**Distros tested in CI logic** (all paths exercised by unit tests; backend integration M1–M7 must be run on the host):

- Ubuntu/Debian, Fedora/RHEL, Arch, openSUSE — `systemd --user`
- Alpine, NixOS, openrc — `cron` fallback (PATH first, then OS PATH)

**Known gaps still on Linux**:

- `getEnhancedPath` fallback list contains `/opt/homebrew/bin` (Mac-specific). Harmless on Linux — just an unused PATH entry.
- The plugin does not auto-detect uninstalled `node` on the host. If `/usr/bin/env node` finds nothing, the runner short-circuits (exit 10) and supervisor falls back to the headless `opencode run` invocation that doesn't need Node.

### Windows notes

Windows scheduled runs go through `schtasks` directly (no supervisor pipeline). As a result:

- The terminal env snapshot is **not** propagated to scheduled tasks (Task Scheduler has no native env-block hook). Jobs run with system env. If your job depends on user env (PATH for Node, MCP tokens), schedule on the same machine using the WSL2 backend (`opencode-scheduler` on Linux) or pin all required env in the prompt itself.
- No-overlap and timeout enforcement come from the OS, not the supervisor.
- Live HTTP delivery via the runner works on Windows (Node + fetch are cross-platform), but only if you start opencode server from Windows side and pass `attachUrl`.

### Platform Support

| Platform | Scheduler backend | Notes |
|------|------|------|
| macOS | `launchd` | Full support (supervised scheduled runs) |
| Linux (systemd available) | `systemd --user` | Full support (supervised scheduled runs) |
| Linux / POSIX (no systemd) | `cron` (`crontab`) | Fallback backend (no missed-run catch-up) |
| Windows | `schtasks` (Task Scheduler) | Supported with cron subset mapping (see limits below) |

Windows Task Scheduler limits:

- Cron expressions that use unsupported combinations (for example, month + weekday constraints, or month-only without explicit day-of-month) return a clear error with guidance.
- Complex cron schedules may be expanded into multiple Windows tasks under `\\OpenCode\\opencode-job-...`.
- Windows scheduled runs currently do **not** use the supervisor pipeline used on macOS/Linux, so no-overlap and timeout enforcement are not guaranteed by the OS integration itself.

---

## Reference

### Cron Syntax

Jobs use standard 5-field cron expressions:

```
┌───────────── minute (0-59)
│ ┌───────────── hour (0-23)
│ │ ┌───────────── day of month (1-31)
│ │ │ ┌───────────── month (1-12)
│ │ │ │ ┌───────────── day of week (0-6, Sunday=0)
│ │ │ │ │
* * * * *
```

| Expression | Meaning |
|------------|---------|
| `0 9 * * *` | Daily at 9:00 AM |
| `0 */6 * * *` | Every 6 hours |
| `30 8 * * 1` | Mondays at 8:30 AM |
| `0 9,17 * * *` | At 9 AM and 5 PM daily |

### Tools

| Tool | Description |
|------|-------------|
| `schedule_job` | Create a new scheduled job |
| `list_jobs` | List all scheduled jobs |
| `get_version` | Show scheduler and opencode versions |
| `get_skill` | Get built-in skill templates (best practices) |
| `install_skill` | Install a built-in skill into your repo |
| `get_job` | Fetch job details and metadata |
| `update_job` | Update an existing job |
| `delete_job` | Remove a scheduled job |
| `cleanup_global` | Remove scheduler artifacts across all scopes (dry-run by default) |
| `run_job` | Execute a job immediately (fire-and-forget) |
| `job_logs` | View the latest logs from a job |

`schedule_job` and `update_job` accept an optional `timeoutSeconds` (integer seconds). Use `0` (or omit) to disable.

`schedule_job` also accepts:

| Arg | Default | Meaning |
|-----|---------|---------|
| `sessionPolicy` | `current` | `current` / `existing` / `new-per-job` / `new-per-run` — see [Session policies](#session-policies). |
| `sessionId` | — | Required for `existing`; optional explicit override for `current`. |
| `executionPolicy` | `prefer-live-server` | `prefer-live-server` (default; live HTTP if reachable, else headless) or `headless-only`. |
| `deliveryPolicy` | `execute` | `execute` (default; wait for idle) or `leave-message` (post with `noReply: true`). |
| `attachUrl` | — | Live-server base URL for HTTP delivery (e.g. `http://127.0.0.1:4096`). |

See [`docs/SCHEDULING.md`](./docs/SCHEDULING.md) for agent-facing inference rules.

Tools accept an optional `format: "json"` argument to return structured output with `success`, `output`, `shouldContinue`, and `data`.

### Global Cleanup

Use `cleanup_global` to clean scheduler artifacts across all scopes. It always starts in dry-run mode unless you pass `confirm: true`.

- Dry run (safe default):

```json
{ "confirm": false }
```

- Execute global cleanup of job definitions + lock files + scheduler units:

```json
{ "confirm": true }
```

- Also delete logs and run history:

```json
{ "confirm": true, "includeHistory": true }
```

The tool reports exactly how many artifacts were removed, grouped by location (jobs, locks, logs, runs, launchd/systemd units).

### Storage

| What | Where |
|------|-------|
| Job configs (scoped) | `~/.config/opencode/scheduler/scopes/<scopeId>/jobs/*.json` |
| Run records (scoped) | `~/.config/opencode/scheduler/scopes/<scopeId>/runs/*.jsonl` |
| Locks (scoped) | `~/.config/opencode/scheduler/scopes/<scopeId>/locks/*.json` |
| Logs (scoped) | `~/.config/opencode/logs/scheduler/<scopeId>/*.log` |
| Supervisor script | `~/.config/opencode/scheduler/supervisor.pl` |
| launchd plists (Mac) | `~/Library/LaunchAgents/com.opencode.job.<scopeId>.*.plist` |
| systemd units (Linux) | `~/.config/systemd/user/opencode-job-<scopeId>-*.{service,timer}` |
| Task Scheduler entries (Windows) | `\\OpenCode\\opencode-job-<scopeId>-*` |

Legacy note: older versions stored jobs in `~/.config/opencode/jobs/*.json` and used unscoped unit names. `delete_job` removes both scoped and legacy artifacts.

### Working Directory

Jobs run from a specific directory to pick up MCP configs:

```
Schedule a daily job at 9am from /path/to/project to run my-task
```

By default, jobs use the directory where you created them.

### Scopes

Scopes are derived from the job's `workdir` (normalized absolute path). This isolates job storage, logs, and OS scheduler unit names per project.

- `list_jobs` defaults to the **current scope** (your current working directory).
- Use `allScopes: true` to list jobs across all scopes.
- Use `includeLegacy: true` to include pre-`v1.2.0` jobs stored in `~/.config/opencode/jobs`.

### Attach URL (optional)

If you have an OpenCode backend running via `opencode serve` or `opencode web`, you can set `attachUrl` on a job so runs use that backend:

```
Update the standing-desk job to use attachUrl http://localhost:4096
```

## Project Philosophy

- This plugin is intentionally a thin wrapper: it schedules `opencode run` via launchd/systemd/schtasks, with cron fallback when native backends are unavailable.
- Logs are the source of truth for scheduled runs: `~/.config/opencode/logs/*.log`.
- Resiliency/reporting roadmap (not implemented): `PRD-resilient-execution.md`.

### Built-in Skill Templates

`schedule_job` auto-installs `scheduled-job-best-practices` into `<workdir>/.opencode/skill/` on first use. The check is idempotent: existing `SKILL.md` is left untouched (so any local edits survive). After that you can reference it from a scheduled prompt:

```
@scheduled-job-best-practices

(your task here)
```

Force a fresh copy (overwrite local edits) or pre-seed before scheduling:

```
Install the scheduled job best practices skill
```

This calls the plugin’s `install_skill` tool. Pass `overwrite=true` if a previous version is already present and you want it replaced.

(Manual option: use `get_skill` to read the template and copy it into `.opencode/skill/scheduled-job-best-practices/SKILL.md` yourself.)

## Troubleshooting

**Jobs not running?**

1. Check if installed:
   - Mac: `launchctl list | grep opencode`
   - Linux: `systemctl --user list-timers | grep opencode`
   - Windows: `schtasks /Query /TN "\\OpenCode\\opencode-job-*"`

2. Check logs: `Show logs for my-job`

3. Verify the working directory has the right `opencode.json` with MCP configs

**MCP tools not available?**

Make sure the job's working directory contains an `opencode.json` with your MCP server configurations.

## License

MIT
