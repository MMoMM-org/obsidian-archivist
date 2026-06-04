# Commands reference

> Every command Archivist contributes to the Obsidian command palette. Use
> this page to look up a command by name, find its preconditions, or
> identify its ID for keybinding configuration.

## How to invoke commands

Open the command palette with **Cmd + P** (macOS) or **Ctrl + P**
(Windows / Linux), then filter by `Archivist:` to scope to plugin commands.
Bind a keyboard shortcut under **Settings → Hotkeys** by searching for the
command name or ID.

## Commands

| Command name | Command ID | Description | Preconditions |
|---|---|---|---|
| **Back up now** | `archivist-backup-now` | Triggers an incremental backup immediately, bypassing the scheduler's quiet-period timer. | The device is the designated backup device, Dropbox is connected, and the FSM is in `READY` state. The command surfaces an inline toast if it's blocked. |
| **Force full backup now** | `archivist-full-backup-now` | Triggers a full backup immediately. Useful when verifying chain recovery or after a long offline period. | Same as *Back up now*. |
| **Open Backup Browser** | `archivist-open-backup-browser` | Opens (or focuses, if already open) the Backup Browser tab — a three-column view of snapshots, files at the selected snapshot, and preview. | None. Works even when Dropbox is disconnected (read-only view of cached state). |
| **Show history of current file** | `archivist-show-file-history` | Opens the file-history modal for the currently active file, listing every snapshot that holds a version. | An active markdown file in the workspace. |
| **Preview retention (dry run)** | `archivist-retention-dry-run` | Evaluates the current retention policy and reports which snapshots would be pruned, without touching anything on Dropbox or the snapshot index. | Dropbox is connected. See [docs/operations/retention-guide.md](operations/retention-guide.md). |
| **Run retention now (delete)** | `archivist-retention-run-now` | Runs retention immediately — deletes the metadata for snapshots outside the keep-set and kicks off the background GC sweep. Bypasses the 24-hour throttle. | Dropbox is connected. |
| **Repair backup index (rebuild from Dropbox manifests)** | `archivist-repair-backup-index` | Rebuilds `snapshot_index.json` from the manifests currently present on Dropbox. Use after corruption or when the index has drifted from reality. | Dropbox is connected. See [docs/troubleshooting/dropbox-corruption.md](troubleshooting/dropbox-corruption.md). |
| **Remove unused backup blobs** | `archivist-gc-orphan-content` | Runs a manual garbage-collection sweep — scans `content/` for blobs not referenced by any kept manifest and deletes them. Normally runs automatically after retention. | Dropbox is connected. |
| **Clear stuck garbage-collection lock** | `archivist-clear-gc-lock` | Removes a stale `gc_lock.json` from Dropbox so the next GC sweep can proceed. Use only if a previous sweep crashed mid-run and the lock has been there longer than expected. | Dropbox is connected. See the *Stale GC lock* section of [docs/troubleshooting/dropbox-corruption.md](troubleshooting/dropbox-corruption.md). |
| **Verify backup ownership** | `archivist-verify-vault-ownership` | Confirms the Dropbox folder's `vault_meta.json` matches this vault's local vault id. Surfaces the Adopt dialog if there's a mismatch. | Dropbox is connected. |

## Notes

- **Command IDs are stable.** Renaming a command label (the *name* column) is
  safe — it changes what the user sees in the palette without breaking any
  hotkey the user has bound, because hotkeys persist by ID. Renaming an ID
  *would* invalidate hotkeys, so IDs are treated as a backwards-compatibility
  surface.
- **Several commands look similar.** *Back up now* and *Force full backup
  now* differ in whether the result is an incremental or a full snapshot.
  *Show history of current file* (palette) opens a modal; the right-click
  **Restore…** menu entry opens a persistent **File Versions** tab — they
  are two distinct surfaces. See
  [docs/usage.md](usage.md#browse-all-versions-of-a-file-file-versions-tab)
  for the distinction.
- **Repair and GC commands are advanced.** They exist for recovery scenarios
  documented in [docs/troubleshooting/dropbox-corruption.md](troubleshooting/dropbox-corruption.md).
  Run them only when the troubleshooting guide directs you to.
