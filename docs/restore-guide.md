# Restoring from Archivist backups

Archivist gives you two paths to recover data:

- **In-app restore** through Obsidian — for normal day-to-day use.
- **Standalone CLI** (`scripts/restore.mjs`) — your break-glass tool when
  the plugin won't load, Obsidian itself is broken, or you just want a
  recovery path that doesn't depend on plugin code at all.

## In-app restore (the common case)

### Restore a single file (quick modal)

1. Open the file in Obsidian.
2. Run **Archivist: Show history of current file** from the command
   palette (`Cmd/Ctrl + P`).
3. Pick a version. The preview pane shows what it looked like.
4. Choose **Restore in-place** (overwrites the live file) or **Restore
   to new location** (writes a copy alongside the original with a
   timestamp suffix — never destructive).

Tip: if you're not 100% sure the version is right, *Restore to new
location* first, compare, then delete the one you don't want.

### Browse all versions of a file (File Versions tab)

For a persistent, side-by-side view — useful when comparing several
versions or keeping the history of more than one file open at once.

1. Right-click the file in the file explorer (or use the markdown
   view's three-dots more-options menu) → **Restore…**.
2. A **File Versions** tab opens with three columns: file info on the
   left, every snapshot that holds a version of this file in the
   middle, preview plus restore actions on the right.
3. Selecting another file via right-click → **Restore…** opens it in
   its own tab, so you can pivot through several files in parallel.

This is the file-pivot surface — one file, many snapshots. The Backup
Browser below is the snapshot-pivot surface — one snapshot, many files.

### Browse a snapshot's contents (Backup Browser)

Use this when you want to see everything as it was at a point in time —
typically to recover a deleted file, restore a whole folder, or sanity-
check what a snapshot actually contains.

1. Open the **Backup Browser** tab from the command palette
   (**Archivist: Open Backup Browser**) or the ribbon icon.
2. Pick a snapshot in the left column. The middle column shows the
   files at that moment.
3. Click a file → preview in the right column → **Restore in-place** or
   **Restore to new location**.
4. To restore a whole folder, click the folder header in the file
   column. The Preview column then offers two actions, both wired:

   - **Restore directory in place** — overwrites matching files in the
     live vault.
   - **Restore directory as copies…** — writes every file alongside its
     original with a shared timestamp suffix, so a batch never
     collides with itself.

   Partial failures do not abort the batch: each file is restored
   through the same hash-verified pipeline as a single-file restore,
   and any failures are collected. The toast reports either
   *N files restored.* on full success or *N restored, M failed. See
   details in notice center.* on partial success, with the first
   failing paths surfaced in a persistent notice.

   Root-level directory restore is rejected with `INVALID_DIR_PREFIX` —
   pick an actual sub-folder, not the vault root.

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

### CLI limitations

These apply only to `scripts/restore.mjs` — the in-app flows are not
affected.

- **No single-file or single-folder restore.** The CLI restores a
  complete snapshot or runs `--verify-only`. To get a single file out,
  restore the whole snapshot to a scratch dir, copy the file you want,
  delete the rest. (See `docs/future-features.md` if you want to track
  per-file CLI as an enhancement.)
- **No vault-merge.** The CLI writes to whatever `--output` directory
  you give it. Merging that back into your real vault is a manual
  decision.
- **No chain repair.** The CLI cannot restore a snapshot whose chain
  is broken on Dropbox (e.g. a missing parent manifest). The plugin
  handles this case by falling back to a fresh full backup; the CLI's
  job is recovery, not repair.

### Plugin limitations

- **Directory restore is per-folder, not vault-wide.** The Backup
  Browser refuses a root-level directory restore (`INVALID_DIR_PREFIX`).
  To restore everything from a snapshot, use the CLI.
- **No undo.** Both *Restore in-place* and *Restore directory in place*
  overwrite the live vault. There is no rollback — use *Restore to new
  location* / *Restore directory as copies…* first if you're unsure.

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
- `docs/operations/retention-guide.md` — for which snapshots remain
  restorable over time; retention prunes older snapshots on a
  hierarchical schedule, so what shows up in the Backup Browser and
  File Versions tab depends on it.
- `docs/troubleshooting/dropbox-corruption.md` — for repair commands
  available inside Obsidian when the plugin still loads.
