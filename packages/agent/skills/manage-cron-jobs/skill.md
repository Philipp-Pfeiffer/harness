---
name: manage-cron-jobs
description: >
  Manage cron jobs for the Harness daemon. Use when: creating, editing, or
  validating cron job files; understanding job frontmatter fields; debugging
  scheduled tasks that aren't running; writing agent-type or script-type jobs.
  Don't use when: the daemon itself is down or unresponsive (use `harness
  daemon status` instead); you need to manage systemd timers (those are
  separate from Harness cron jobs).
level: molecule
status: active
routable: true
---

# Manage Cron Jobs

Harness daemon cron jobs are Markdown files with frontmatter, stored in
`$HARNESS_STATE/jobs/*.md`. The daemon's `CronScheduler` loads them on
startup and reloads when the directory changes.

## Job File Format

```markdown
---
name: metrics-rotation
schedule: 0 3 * * *
enabled: true
type: script
jitter: 2h
---
metrics-rotation
```

### Frontmatter Fields

| Field     | Required | Description                                           |
|-----------|----------|-------------------------------------------------------|
| `name`    | yes      | Human-readable job name                               |
| `schedule`| yes      | Cron expression (5 or 6 fields, croner syntax)        |
| `enabled` | no       | `true` (default) or `false` — disabled jobs are parsed but never scheduled |
| `type`    | yes      | `agent` or `script`                                   |
| `jitter`  | no       | Max random start delay per run, e.g. `30m`, `2h`     |
| `agent`   | no       | Agent profile name (`type: agent` only) — the job's session runs with that profile's prompt, model and tool set. Default: `default`. Unknown profiles fail the run with a logged error |

### Body

- **`type: agent`** — the body is a prompt sent as the first turn in a new
  session with `origin: "cron"`. The session appears in `harness sessions`
  like any other.
- **`type: script`** — the body is the name of a function registered in the
  daemon's internal script registry. Unknown names are logged as job errors;
  the daemon keeps running.

## Path

Job files live in `$HARNESS_STATE/jobs/` (default: `~/.harness/jobs/`).
Any `*.md` file in that directory is treated as a job definition.

## Registered Script Names

Built-in script functions available for `type: script` jobs:

- **`metrics-rotation`** — Deletes metric files (`turns|tools|system-*.jsonl`)
  older than `logRetentionDays` (default 14). Runs daily at 3am by default.

## Example: Agent Job

```markdown
---
name: daily-summary
schedule: 0 9 * * *
enabled: true
type: agent
jitter: 15m
---
Summarize yesterday's sessions and write a brief report to memory/_inbox.md.
Include total turns, token usage, and any errors.
```

## Example: Agent Job with Profile

```markdown
---
name: distill-notes
schedule: 0 5 * * *
enabled: true
type: agent
agent: distillation-daily
---
Distill this week's notes into long-term memory entries.
```

The `agent` field selects an agent profile (built-in under `agents/<name>/`
in the repo, or user-defined in `$HARNESS_HOME/agents/<name>/agent.md`).
Without it, jobs run under the `default` profile.

## Example: Script Job

```markdown
---
name: metrics-rotation
schedule: 0 3 * * *
enabled: true
type: script
jitter: 2h
---
metrics-rotation
```

## ⚠️ Job Storms

**Avoid minütliche agent-Jobs (every-minute agent jobs).** Agent-type jobs
spawn a full agent session per run — each one loads the model, system prompt,
and tools. Schedules like `* * * * *` (every minute) will:

- Exhaust API rate limits
- Consume token budget rapidly
- Create many concurrent sessions (the daemon blocks overlapping runs
  of the *same* job, but different jobs run in parallel)

**Guidance:**
- Minimum practical interval for agent jobs: 15–30 minutes
- Use `jitter` to spread concurrent jobs
- For frequent tasks, use `type: script` instead (no model load)
- Monitor via `harness daemon status` → sessions count

## Error Handling

- Job errors are **caught and logged** — the daemon never crashes from a
  job failure.
- Errors land in the **daemon log** at `$HARNESS_STATE/logs/daemon-YYYY-MM-DD.log`.
- View recent logs with `harness daemon logs`.
- Missed runs are **not caught up** — if the daemon is down, past schedules
  are skipped entirely.
- Overlapping runs of the **same job** are blocked (croner `protect`).

## Managing Jobs

```bash
# List all sessions (including cron-originated ones)
harness sessions

# Check daemon status (shows sessions, uptime, last errors)
harness daemon status

# View daemon logs (last 100 lines)
harness daemon logs

# Reload config without restart (picks up new job files automatically via fs.watch)
harness reload-config
```
