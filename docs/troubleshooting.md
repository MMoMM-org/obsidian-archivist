# Troubleshooting

> Top-level troubleshooting index. Specific failure modes have their
> own deep guides linked below; this page is the entry point so you
> can find the right one quickly.

## Common issues

The most-covered failure modes today:

- **Dropbox-side corruption** — broken backup chain, vault id mismatch,
  stale orphan content, GC lock cleanup. See
  [Dropbox-side corruption](troubleshooting/dropbox-corruption.md) for
  the repair commands and the bug-report capture flow.

### Plugin doesn't appear in Settings after install

- **Check the Obsidian version.** Archivist needs Obsidian **1.14.4
  or newer** (`manifest.json` `minAppVersion`). On older Obsidian,
  Community Plugins offers only the last 0.11.x release, and that
  install receives no further updates. If Archivist does appear but
  stays on 0.11.x, this is the reason: update Obsidian to get 0.12.0
  and later.
- **Check the platform.** Archivist is desktop-only
  (`isDesktopOnly: true`). On iOS or Android, it will not appear in the
  community-plugins list.
- **Cycle the plugin.** **Settings → Community plugins →
  Installed plugins → Archivist** toggle off, then back on. Manual
  installs in particular need this after the files change.
- **Check the developer console.** **Cmd/Ctrl + Shift + I → Console**.
  An error mentioning `archivist` typically points at a malformed
  manifest or a missing build artifact in
  `.obsidian/plugins/archivist/`.

### Backup commands missing from the command palette

The most common cause is that Archivist isn't enabled. Check
**Settings → Community plugins → Installed plugins → Archivist** —
the toggle on the right must be on. If it is on and commands are
still missing, restart Obsidian (or disable + re-enable the plugin)
so commands re-register.

### Dropbox authorization lost (AUTH_LOST banner)

The persistent banner *"Archivist lost access to your Dropbox account.
Open settings to reconnect"* means Dropbox rejected the stored token.
Common causes: the user removed the app from
[Dropbox → Settings → Connected apps](https://www.dropbox.com/account/connected_apps),
changed their Dropbox password, or the token aged out without a
refresh.

Fix: **Settings → Archivist → Dropbox account → Connect Dropbox** and
complete the OAuth flow. Backups resume automatically on the next
scheduler tick. The banner disappears as soon as the first
post-reconnect backup commits successfully.

### Backups paused — storage cap reached

Archivist defaults to a 200 GB hard limit on Dropbox usage. When the
folder hits the cap, scheduled backups pause and the status bar
surfaces a warning. Existing snapshots are **not** auto-deleted in
this case — the cap is a brake, not a pruner.

Fix: either **raise the cap** under **Settings → Archivist → Retention
→ Hard storage limit (GB)**, or **shrink retention windows** (lower
`daily_days` / `monthly_years`) so the next retention pass frees up
space. The *Preview retention (dry run)* command lets you check the
effect of new tier values before applying them. See
[docs/operations/retention-guide.md](operations/retention-guide.md).

### "Two devices are designated as the backup owner"

You have two installs of Archivist both flagged as the designated
backup device for the same vault. Both can *read* from the shared
Dropbox folder safely, but only one should *write* — otherwise the
manifests interleave and the chain gets confused.

Fix: pick one device in **Settings → Archivist → Schedule → This
device backs up the vault** and toggle the other off. Archivist will
not lose data while this is unresolved — the warning is preventive.

### A settings field "won't save" / silently reverts

Most fields in the Advanced section validate on input. If a value
fails validation, the change handler aborts and the field reverts to
the previous valid value — without a UI hint in older versions.

- **Vault folder name (`vault_prefix`)** is strictly lowercase
  alphanumerics, hyphens, and underscores. `Test-Vault` is rejected;
  `test-vault` is accepted. The validation error now surfaces as an
  inline red message under the field — if you don't see one and the
  value keeps reverting, you're on an older build; update.
- **Exclusion globs** must each be valid glob patterns. Check the help
  text below the field for the supported syntax.
- **Concurrent uploads** is bounded to `1`–`8`; values outside the
  range revert.
- **Upload chunk size (MB)** is bounded to `4`–`64`.

### Backup Browser or a restore takes a long time

The Backup Browser and File versions read the snapshot list and the
backup chain from Dropbox. On a large vault with many incremental
backups since the last full backup this can take a while. The loading
message says what is being loaded and adds *"Still working — large
vaults take longer"* after a few seconds. A restore shows
*"Restoring …"* until the result notice replaces it.

If the snapshot list cannot be loaded (Dropbox not connected, snapshot
index missing or damaged), the snapshots column shows the error and a
**Retry** button. With diagnostic logging on, **Archivist: Show
diagnostics** shows the chain
length since the last full backup, which is the main cause of slow
loads.

### Archivist settings don't appear in Obsidian's settings search

Obsidian's settings search finds Archivist's settings only with
Archivist **0.12.0 or later**, which needs Obsidian **1.14.4 or newer**.
If a search for an Archivist setting (for example *retention* or
*Dropbox*) returns nothing:

- **Check that Archivist is enabled** under **Settings → Community
  plugins**. A disabled plugin has no settings to find.
- **Check the Archivist version** in the same list. Version 0.11.x
  doesn't support settings search. If an update is offered, install it.
- **No update offered?** Your Obsidian is most likely older than 1.14.4,
  so Community Plugins only offers the last 0.11.x release. Update
  Obsidian to 1.14.4 or newer, then check for plugin updates again.

On 0.11.x the settings still work as before under
**Settings → Archivist**; only the search doesn't find them.

## Debug information

Archivist logs to Obsidian's developer console. To open it:

- **macOS**: **Cmd + Option + I** (or **View → Toggle Developer Tools**).
- **Windows / Linux**: **Ctrl + Shift + I**.

Filter the console for `[archivist]` to drop unrelated Obsidian noise.
Default-mode logs are minimal and contain no path data. For a fuller
trace, toggle **Settings → Archivist → Advanced → Diagnostic logging**
on before reproducing the issue, then turn it back off afterward —
the toggle exposes per-file paths and FSM/cache transitions, which is
exactly the kind of detail a maintainer needs to follow what happened.

With diagnostic logging on, the command palette also offers
**Archivist: Show diagnostics** — a one-page summary of backup, chain
and scheduler state (last full backup, chain depth, next scheduled
full, last error code, cache statistics). **Copy report** puts it on the
clipboard; it holds metadata only, no file contents or paths.

Useful log prefixes:

- `backup_` — backup lifecycle (start, files written, done).
- `fsm_transition` — scheduler state changes (only visible with
  diagnostic logging on).
- `manifest_cache_invalidated` — cache flush events after a commit or
  a retention prune (diagnostic logging only).
- Timing lines for slow loads and restores (diagnostic logging only):
  `snapshot_index_loaded` (snapshot count, download and parse time),
  `manifest_loaded` (cache hit or miss, download time),
  `materialize_done` (how many snapshots a restore had to replay),
  `restore_blob_fetched`, `history_manifests_loaded` (File versions and
  Show history: how many snapshot manifests were loaded, cache hits and
  misses, duration), `chain_walk_done` (chain length checked at
  the first backup of a session) and `backup_run_started` /
  `backup_run_done` (backup kind, reason and duration).
- `full_schedule_check` — at startup: when the last full backup ran,
  when the next one is due, and whether one is overdue (diagnostic
  logging only).
- `retention_pruned` — one line per snapshot retention deleted.
- `repair_` / `gc_` — repair commands and garbage-collection sweeps.

For deep Dropbox-side corruption scenarios, the full bug-report
capture flow is in
[troubleshooting/dropbox-corruption.md](troubleshooting/dropbox-corruption.md#what-to-capture-for-a-bug-report).

## Getting help

File issues at
[github.com/MMoMM-org/obsidian-archivist/issues](https://github.com/MMoMM-org/obsidian-archivist/issues).

To make the issue actionable, include:

1. **Plugin version** — from **Settings → Community plugins →
   Installed plugins → Archivist** (or `manifest.json` in
   `.obsidian/plugins/archivist/`).
2. **Obsidian version** — from **Settings → About**.
3. **Operating system** — macOS / Windows / Linux + version.
4. **Symptom** — one sentence describing what you observed.
5. **Steps to reproduce** — even rough ones help.
6. **Console output** — with **Diagnostic logging** enabled and the
   `[archivist]` filter applied. See **Debug information** above.

Sensitive data note: turning Diagnostic logging on emits per-file
paths. If your vault contains paths you don't want to share, redact
them before pasting the log — or describe the issue without the full
trace and let the maintainer ask for the specific lines they need.
