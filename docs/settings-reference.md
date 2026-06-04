# Settings reference

> Hand-authored companion to [Configuration](configuration.md). Configuration
> is the field-level table (name, type, default, description); this page is
> the *why and when to change* — grouped per section as the settings tab
> presents them.

For the canonical list of fields, defaults, and one-line descriptions, see
[Configuration](configuration.md). This page assumes you already know
*what* a setting is and need to decide *whether to change it*.

## Backup schedule

Controls when backups run. Defaults are tuned for "a vault that gets edited
during typical working hours and should have a daily full + frequent
incrementals overnight".

- The **Designated device toggle** is the on/off switch for backups on
  *this* device. Exactly one device per vault should be designated; multiple
  devices designated for the same vault folder is a misconfiguration that
  the plugin detects and warns about, but doesn't prevent.
- **Full backup cadence + day + time** schedule the next full backup. A
  weekly full + 15-minute incrementals is a reasonable starting point and
  keeps the manifest chain length manageable.
- **Incremental backup interval** is how often the scheduler considers
  running an incremental. Real backups only happen if the change detector
  has observed at least one vault edit since the last commit — quiet
  intervals are skipped without touching Dropbox.
- The **Active window** (off by default) restricts both fulls and
  incrementals to a daily time range. Turn it on if you don't want backups
  running during work hours (e.g. limited bandwidth) or want to suppress
  overnight activity.
- **Startup grace** and **Quiet period after edits** are jitter buffers.
  Startup grace delays the first scheduled backup after Obsidian launches
  (default 10 minutes); the quiet period waits for the vault to settle
  after the last edit before running an incremental (default 2 minutes).
  Raise either if you see "backups firing during interactive use".

<!-- TODO: section-by-section recommendations for "small vault" /
"large vault" / "bandwidth-constrained" / "high-frequency editing" profiles. -->

## Retention

Controls how many snapshots survive retention sweeps. See
[Operations: Retention](operations/retention-guide.md) for the full tier
model.

- **Always keep most-recent snapshots** is the safety floor. Defaults to 3.
  Raise it if you set `Daily retention (days)` to a low number (1 or 2),
  or if you make small infrequent changes and want extra known-good states
  on hand. Setting it to 0 disables the floor — almost never what you
  want.
- **Recent high-frequency window** and **Never-prune window** are the two
  blanket-keep rules. Everything inside the recent hours window stays
  unconditionally; everything inside the never-prune days window stays
  unconditionally. They overlap — that's fine.
- **Daily retention (days)** and **Monthly retention (years)** are the
  thinning rules. Past the never-prune window, only the newest snapshot
  per calendar day survives, then past the daily window only the newest
  per calendar month, up to the configured year horizon.
- **Hard storage limit (GB)** and **Warn at percent of cap** are
  informational only in the current implementation. They drive the
  settings-tab storage indicator but do not enforce uploads — incremental
  and full backups proceed regardless of usage versus the limit. The
  warning is the operational signal; act on it by lowering retention
  windows.

The interaction to watch out for: a "no-changes" incremental doesn't
create a new snapshot, so today's daily-tier bucket can stay empty even
after a successful backup. That's the failure mode `Always keep most-recent
snapshots` exists to backstop. See
[Operations: Retention](operations/retention-guide.md#the-no-changes-footgun)
for the full explanation.

## Notifications

Controls which toasts appear after backup events. All toggles default to
sensible values for "watch what's happening initially, quiet down later".

- **Show pre-flight notice before full backups** is the postpone/skip
  prompt that appears a few minutes before a scheduled full. Useful if
  you want a chance to defer the bandwidth hit before it starts. Off only
  if the prompt becomes a habit-broken click — but then you lose the
  postpone path.
- **Show toast after incremental backup** is off by default because
  incrementals run every 15 minutes and the toast quickly turns into
  noise. Turn it on temporarily while validating that backups are
  actually running.
- **Show toast after full backup** is on because fulls are rare (weekly
  by default) and the confirmation is reassuring.
- **Show toast on error** is on because errors should be visible.
  Turning it off means failures only surface in the developer console.

## Advanced

Power-user knobs. Default values are correct for typical use; reach for
these only when you have a specific reason.

- **Enable reconcile scan on startup** rebuilds the change queue from a
  vault-wide diff against the last manifest. It catches edits that
  happened while Obsidian was closed. Turning it off speeds up plugin
  startup at the cost of missing offline edits until the next manual
  trigger.
- **Exclusion globs** is a one-pattern-per-line list of vault paths to
  skip in backups. Use this to exclude transient or sensitive folders.
  Patterns support `*`, `**`, `?`, and `[abc]` character classes.
  Example: `.trash/**` to skip the Obsidian trash folder.
- **Dry-run mode (no uploads)** runs the full backup pipeline without
  actually writing to Dropbox. Useful when validating a `vault_prefix`
  change, a new `exclusion_globs` pattern, or simply checking that the
  plugin can see all the files it should. Turn off before you expect
  data to actually land on Dropbox.
- **Dropbox vault folder** is the folder name under `Apps/Archivist/`.
  Defaults to a slug of the vault name. Change it if you back up several
  vaults from one Dropbox account and want them in distinct folders. If
  the new folder already has backups from another install, the next
  launch shows the **Adopt** dialog. See
  [docs/operations/connecting-existing-backup.md](operations/connecting-existing-backup.md).
- **Diagnostic logging** makes the plugin emit per-file paths and
  FSM/cache transitions to the developer console. Off by default because
  the logs disclose vault contents. Turn it on temporarily when
  preparing a bug report, then turn it off again.
- **Concurrent uploads** sets how many uploads run in parallel.
  Defaults to 2. Range: 1–8. Higher values speed up backups on
  accounts with generous Dropbox API budgets but risk rate-limit
  cycles on Plus-tier accounts.
- **Upload chunk size (MB)** sets the chunk size for large file
  uploads. Defaults to 8. Range: 4–64. Smaller chunks reduce
  memory use; larger chunks reduce round-trips on big files.

## Dropbox account

The Dropbox section of the settings tab is connection state, not
configuration. It shows the connected account email, used storage, and
the **Connect Dropbox** / **Disconnect** button.

The setup flow (OAuth, scope rationale, vault folder name) is documented
in the **Setup** and **Dropbox scopes** sections of the
[root README](../README.md). The mechanics of pointing this device at a
folder that already has backups live in
[docs/operations/connecting-existing-backup.md](operations/connecting-existing-backup.md).

<!-- TODO: cover account-switching (disconnect + reconnect to a different
account), token storage location, and what to do when OAuth fails. -->
