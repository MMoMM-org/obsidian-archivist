# Configuration

> Every configuration setting available in Archivist, grouped by the
> sections that appear in the Obsidian settings tab. Generated from
> `src/model/Settings.ts` by the doc-product `extract` mode — re-run
> after any settings change.

This page documents every configuration setting available in Archivist. Each row
describes a single field: its name, expected type, default value, and what it
controls. Fields marked `[NEEDS DESCRIPTION]` require author attention before
the documentation is complete.

The source of truth for settings is `src/model/Settings.ts`. This page is
generated from that file by the doc-product `extract` mode — re-run after any
settings change.

## How to open settings

In Obsidian: **Settings → Community plugins → Archivist → gear icon**. The
settings tab groups fields into sections that match the H2 headings below.

## Backup schedule

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `full_cadence` | `FullCadence` | `'weekly'` | Full backup cadence — how often a fresh full snapshot replaces the incremental chain. |
| `full_day_of_week` | `DayOfWeek` | `0` | Day of the week the next full backup runs (`0` = Sunday). |
| `full_time_of_day` | `string` | `'03:00'` | Local time of day the next full backup is scheduled to run. |
| `inc_interval_minutes` | `IncIntervalMinutes` | `15` | Incremental backup interval (minutes between scheduled incrementals). |
| `active_window_enabled` | `boolean` | `false` | When enabled, backups only run inside the active window below. |
| `active_window_start` | `string` | `'08:00'` | Start of the active window (local time). |
| `active_window_end` | `string` | `'22:00'` | End of the active window (local time). |
| `startup_grace_minutes` | `number` | `10` | Startup grace period — minutes after plugin load before the first scheduled backup may run. |
| `quiet_after_event_minutes` | `number` | `2` | Quiet period after edits — minutes the plugin waits after the last vault change before running an incremental backup. |

## Retention

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `always_keep_n` | `number` | `3` | Floor that protects the N most-recent snapshots regardless of tier evaluation. Prevents accidentally pruning all backups when tier settings are very aggressive (e.g. `daily_days=1` plus a quiet day during which no new snapshot was created). `0` disables the floor. |
| `never_prune_window_days` | `number` | `14` | Never-prune window — every snapshot within this many days back is kept, no thinning. |
| `recent_hours` | `number` | `24` | Recent high-frequency window — every snapshot within this many hours back is kept. |
| `daily_days` | `number` | `30` | Daily retention — keep one snapshot per local calendar day, up to this many days back. |
| `monthly_years` | `number` | `3` | Monthly retention — keep one snapshot per local calendar month, up to this many years back. |
| `storage_hard_limit_gb` | `number` | `200` | Hard storage limit (GB) — informational ceiling shown in the settings tab. |
| `storage_warn_at_percent` | `number` | `80` | Surface a warning when used storage reaches this percentage of the hard limit. |

See [docs/operations/retention-guide.md](operations/retention-guide.md) for
how these settings interact and tuning guidance.

## Notifications

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `preflight_notice_enabled` | `boolean` | `true` | Show pre-flight notice before full backups so you can postpone or skip. |
| `toast_after_inc` | `boolean` | `false` | Show a toast after every incremental backup. |
| `toast_after_full` | `boolean` | `true` | Show a toast after every full backup. |
| `toast_on_error` | `boolean` | `true` | Show a toast when a backup fails. |

## Advanced

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `reconcile_scan_enabled` | `boolean` | `true` | Enable reconcile scan on startup — rebuilds the change queue from a vault-wide diff against the last manifest. |
| `exclusion_globs` | `string[]` | `[]` | One pattern per line. Supports `*`, `**`, `?`, and `[abc]` character classes. Example: `.trash/**`. |
| `dry_run_mode` | `boolean` | `false` | Dry-run mode — runs the backup pipeline without actually uploading to Dropbox. Useful for verifying scope and exclusions. |
| `vault_prefix` | `string` | `''` | Folder name under `Apps/Archivist/`. Lowercase letters, numbers, hyphens, underscores. Changing this requires restarting Obsidian; if the new folder already has backups from another vault, the next launch shows the Adopt dialog. See [docs/operations/connecting-existing-backup.md](operations/connecting-existing-backup.md). |
| `diagnostic_logging` | `boolean` | `false` | Diagnostic logging — when enabled, the developer console emits per-file paths and FSM/cache transitions. Off by default to avoid disclosing vault contents in logs. |
| `upload_parallelism` | `number` | `2` | Concurrent uploads. Range: 1–8. Higher values speed up backups on accounts with generous Dropbox API budgets but risk rate-limit (429) cycles on Plus-tier accounts. |
| `chunk_size_mb` | `number` | `8` | Upload chunk size (MB). Range: 4–64. Smaller chunks reduce memory use; larger chunks reduce round-trips on big files. |

## Tips

- Set `always_keep_n` to a non-zero value if you ever set `daily_days` to `1` or
  `2` — the floor protects you from the "no-changes day" footgun. See
  [docs/operations/retention-guide.md](operations/retention-guide.md) for the
  full explanation.
- `dry_run_mode` and `diagnostic_logging` are useful together when validating
  a vault-prefix change or a new `exclusion_globs` pattern without committing
  to a real upload.
- `upload_parallelism` defaults to `2` for safety on Dropbox Plus accounts.
  Raise it only if you're on a Professional/Business account and you've
  observed slow throughput without 429 noise in the developer console.
