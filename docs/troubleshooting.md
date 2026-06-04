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

- **Check the Obsidian version.** Archivist needs Obsidian **1.11.4
  or newer** (`manifest.json` `minAppVersion`). Older versions silently
  ignore the plugin.
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

Useful log prefixes:

- `backup_` — backup lifecycle (start, files written, done).
- `fsm_transition` — scheduler state changes (only visible with
  diagnostic logging on).
- `manifest_cache_invalidated` — cache flush events after a commit or
  a retention prune (diagnostic logging only).
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
