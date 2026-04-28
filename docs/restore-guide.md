# Restoring from Archivist backups

Archivist gives you two paths to recover data:

- **In-app restore** through Obsidian — for normal day-to-day use.
- **Standalone CLI** (`scripts/restore.mjs`) — your break-glass tool when
  the plugin won't load, Obsidian itself is broken, or you just want a
  recovery path that doesn't depend on plugin code at all.

## In-app restore (the common case)

### Restore a single file

1. Open the file in Obsidian.
2. Run **Archivist: Show history of current file** from the command
   palette (`Cmd/Ctrl + P`).
3. Pick a version. The preview pane shows what it looked like.
4. Choose **Restore in-place** (overwrites the live file) or **Restore
   to new location** (writes a copy alongside the original with a
   timestamp suffix — never destructive).

Tip: if you're not 100% sure the version is right, *Restore to new
location* first, compare, then delete the one you don't want.

### Restore a deleted file or browse history

1. Open the **Backup Browser** tab from the command palette
   (**Archivist: Open Backup Browser**) or the ribbon icon.
2. Pick a snapshot in the left column. The middle column shows the
   files at that moment.
3. Click a file → preview in the right column → **Restore in-place** or
   **Restore to new location**.
4. To restore a whole folder: click the folder header in the file
   column → use the bulk restore action.

### Find a file across renames

The history view tracks rename markers in the manifest, so renaming
`old.md` → `new.md` doesn't break the trail. The history panel shows
**Renamed from "old.md" on 2026-04-20** for the version where the
rename happened.

## Standalone CLI — `scripts/restore.mjs`

### When to reach for this

- The plugin won't load or Obsidian itself is broken.
- Your Dropbox account is locked and you can't reconnect.
- You want a recovery path that has zero dependencies on plugin code,
  the Obsidian runtime, the network, or anything you might have
  introduced a bug in.

### Where to get the script

Three places, pick whichever is easiest:

1. **From the GitHub release** — every release at
   <https://github.com/MMoMM-org/obsidian-archivist/releases> includes
   `restore.mjs` as a release asset. Download it directly.
2. **From your existing plugin install** — the script is bundled in
   `<vault>/.obsidian/plugins/obsidian-archivist/scripts/restore.mjs`.
3. **From the source repo** —
   <https://github.com/MMoMM-org/obsidian-archivist/blob/main/scripts/restore.mjs>.
   It's a single file, copy-and-paste works.

### What you need on disk

The CLI runs against a **local mirror** of the Dropbox folder — it
never authenticates to Dropbox. The Dropbox Desktop app's selective-sync
gives you this for free: `Apps/Archivist/<vault-prefix>/` lives at
something like `~/Dropbox/Apps/Archivist/<vault-prefix>/` once synced.

If you don't run the Dropbox Desktop app, you can also: download the
folder via the Dropbox web UI as a ZIP, extract it, and point `--input`
at the extracted dir.

### Requirements

- **Node 18+** (uses Node-stdlib only — no `npm install`, no
  dependencies)
- The local Dropbox-mirror folder

### Usage

```bash
# 1. List what snapshots are available.
node restore.mjs --input ~/Dropbox/Apps/Archivist/my-vault --list-snapshots

# 2. Restore the most recent snapshot.
node restore.mjs \
  --input ~/Dropbox/Apps/Archivist/my-vault \
  --at latest \
  --output ./restored

# 3. Restore a specific date.
node restore.mjs \
  --input ~/Dropbox/Apps/Archivist/my-vault \
  --at 2026-04-20 \
  --output ./restored

# 4. Restore a specific snapshot by id (or prefix).
node restore.mjs \
  --input ~/Dropbox/Apps/Archivist/my-vault \
  --at 2026-04-20T03-00-full \
  --output ./restored

# 5. Dry-run: see what would be written without writing anything.
node restore.mjs \
  --input ~/Dropbox/Apps/Archivist/my-vault \
  --at latest \
  --output ./restored \
  --dry-run

# 6. Verify the integrity of every blob in a snapshot (no writes).
node restore.mjs --input ~/Dropbox/Apps/Archivist/my-vault --verify-only
```

### `--at` selectors

| Selector | Picks |
|----------|-------|
| `latest` (or omitted) | Whatever HEAD.json points at |
| `2026-04-20` | The most recent snapshot whose id starts with that date |
| `2026-04-20T03-00-full` | Exact snapshot id |
| `T03-00-full` | Substring match (errors if ambiguous) |

### What you get out

A directory at `--output` containing every file as it existed in that
snapshot, paths preserved relative to your vault root. The CLI writes
files atomically (each file goes to a temp name, then rename) so a
crash during restore doesn't leave you with half-written notes.

The CLI verifies every blob's SHA-256 against the manifest before
writing — if a blob is corrupt on disk, restore aborts with
`CONTENT_HASH_MISMATCH` and the path of the bad blob, before any output
is written.

## Limitations

- **Single-file CLI restore is not currently supported.** The CLI
  restores a complete snapshot or runs `--verify-only`. For per-file
  CLI restore, the workflow today is: restore the whole snapshot to a
  scratch dir, copy the file you want out of it, delete the rest. (See
  `docs/future-features.md` if you want to track per-file CLI as an
  enhancement.)
- The CLI does not sync with the live vault — it writes to whatever
  `--output` directory you give it. Merging that back into your real
  vault is a manual decision.
- The CLI cannot restore a snapshot whose chain is broken on Dropbox
  (e.g. a missing parent manifest). The plugin handles this case by
  falling back to a fresh full backup; the CLI's job is recovery, not
  repair.

## Best practices

- **Test a restore once a quarter.** Pick a recent snapshot, restore to
  a scratch dir, spot-check a few files. A backup you've never restored
  is just a hopeful folder full of bytes.
- **Try `--verify-only` before relying on a snapshot.** If the verify
  finds nothing wrong, the blob layer is intact and the manifest is
  consistent — the snapshot is recoverable.
- **Keep one copy of `restore.mjs` somewhere outside the vault.** A USB
  stick, a different machine, an email to yourself. If your vault is
  the thing you're trying to recover, the script that's bundled
  *inside* it doesn't help you.

## Related docs

- README's *Setup* and *Dropbox scopes* sections — for the OAuth and
  permission picture.
- `docs/architecture-overview.md` — for why the CLI works the way it
  does (content-addressed storage, manifest chain).
- `docs/troubleshooting/dropbox-corruption.md` — for repair commands
  available inside Obsidian when the plugin still loads.
