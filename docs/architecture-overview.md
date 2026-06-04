# Architecture overview — how Archivist actually works

> User-facing primer on the moving parts. If you want the full
> engineering spec, see `docs/XDD/specs/001-archivist-plugin/solution.md`.
> If you just want to back stuff up, the README is enough.

## The one-paragraph summary

Archivist takes snapshots of your Obsidian vault and stores them in your
Dropbox app folder as **content blobs** (deduped by hash) plus
**manifests** (per-snapshot file maps). It can reconstruct any historical
state of the vault by walking back through manifests and assembling the
files that snapshot referenced. Identical content shared across snapshots
or files is stored once. There is no "current copy of your vault" sitting
on Dropbox — instead, every snapshot you keep can be rebuilt deterministically.

## The three things on Dropbox

When Archivist runs, it writes to a single folder under your Dropbox
**App Folder** scope at `Apps/Archivist/<vault-prefix>/`. Inside, you'll
find roughly this layout:

```
Apps/Archivist/<vault-prefix>/
├── HEAD.json              ← pointer to the latest snapshot
├── snapshot_index.json    ← lightweight metadata cache (all snapshots, one file)
├── vault_meta.json        ← who owns this folder (vault_id + name)
├── snapshots/             ← one JSON manifest per snapshot
│   ├── 2026-04-24T10-00-full.json
│   ├── 2026-04-24T11-15-inc.json
│   └── …
└── content/               ← the actual file bytes, addressed by SHA-256
    ├── ab/cdef…
    ├── 12/3456…
    └── …
```

**Why it's not just files in folders:** if Archivist mirrored your vault
1:1, every snapshot would re-upload everything, every rename would re-upload,
and old versions would either pile up or be lost on the next sync. The
content-addressed layout gives you four properties at once:

1. Identical files dedupe automatically (a 50 MB attachment shared across
   100 snapshots costs 50 MB total, not 5 GB).
2. Renames cost nothing — only the manifest changes.
3. Snapshots are immutable and verifiable: every blob's path is its hash.
4. Garbage collection is mechanical — anything in `content/` not
   referenced by any manifest is orphaned and can be deleted.

The trade-off: **you cannot pick a file out of Dropbox by hand**. The
contents in `content/` look like this — `content/ab/cdef…` — instead of
`content/notes/My Note.md`. To reconstruct a specific file, you need a
manifest pointing at the right blob. That's what the plugin does for
in-app restore, and what the standalone CLI does for break-glass recovery.

## Snapshots: full and incremental

Two kinds of snapshots:

- **Full** — every file in the vault is recorded in the manifest.
  These are the anchors. Created on first backup, on schedule (default
  weekly), or any time the chain breaks.
- **Incremental (inc)** — only the files that changed since the last
  snapshot are recorded; the rest are inherited from the parent. Forms
  a chain back to the most recent full.

When restoring at any point in time, Archivist walks back through the
chain (inc → inc → … → full), merging each manifest's "what changed"
forward, until it has the complete file map for that snapshot. This is
what `materializeVaultStateAt(snapshot_id)` does.

If a manifest in the chain is missing or corrupt, the chain is **broken**
and Archivist falls back to a fresh full backup on the next cycle.
Older snapshots in the broken chain become unreadable through the plugin
UI but are still listed (for transparency) and remain accessible through
the standalone CLI tool, which can recover what's still intact.

## Retention: two safety floors plus three time-window tiers

Without retention, every backup would be kept forever and your Dropbox
storage would fill. Archivist evaluates five keep-rules in parallel and a
snapshot survives if **any** rule wants it kept. Two of the rules are
safety floors that ignore wall-clock buckets; three are time-window
tiers that thin older history.

| Rule | Default | What it keeps |
|------|---------|---------------|
| Always keep most-recent snapshots | 3 | The N newest snapshots, full stop |
| Never-prune window (days) | 14 | Every snapshot inside the window, no thinning |
| Recent high-frequency window (hours) | 24 | Every snapshot inside the window |
| Daily retention (days) | 30 | One snapshot per local calendar day |
| Monthly retention (years) | 3 | One snapshot per local calendar month |

A snapshot can be referenced by multiple rules (a recent monthly snapshot
also covers a daily slot during its month). The *Always keep most-recent
snapshots* floor (`always_keep_n` in `data.json`, default 3) is the
backstop: even if every tier above is configured to 0 and you go through
a quiet stretch with no new backups, the N newest snapshots are kept
unconditionally so an aggressive policy can't wipe the whole history.

When retention prunes snapshots, it fire-and-forget triggers a GC sweep
so orphaned blobs are reclaimed in the same cycle. The same GC also runs
after every successful backup, throttled to once per 24 hours. See
`docs/operations/retention-guide.md` for the preview/run commands and
real-world tuning notes.

## Multi-device coordination

If you use Obsidian Sync (or similar) across machines, multiple devices
might run Archivist against the same Dropbox folder. The plugin handles
this with two mechanisms:

- **One designated device.** Settings → Schedule → *This device backs up
  the vault* must be ON for one device. The others see your snapshots
  but don't write — they're read-only consumers.
- **`vault_meta.json` ownership.** The folder gets stamped with a
  `vault_id` UUID generated by your first backing-up device. Backups
  refuse to write if the local `vault_id` doesn't match the Dropbox-side
  `vault_meta.json` — so a misconfigured second vault can't accidentally
  scribble into the first vault's history.

Per-device state (the device UUID and the designated flag) lives in a
**sidecar file** inside the plugin folder, NOT in `data.json`. This
keeps it from being replicated across devices when Obsidian Sync runs
(`data.json` is sync-eligible; the sidecar is not).

> **Heads up for non-Obsidian-Sync users:** iCloud, Syncthing, and the
> Dropbox Desktop app's vault-folder sync replicate **everything** under
> the vault, sidecar files included. If you use those tools, exclude
> `.obsidian/plugins/obsidian-archivist/` from sync on each device. See
> the README's *How tokens are stored* section.

## Restore: in-app vs CLI

There are two ways to recover data:

- **In-app**, from the Backup Browser tab or the *Show history of
  current file* command. Works for: browsing snapshots, previewing
  files, restoring individual files (in-place or as a copy with a
  timestamp), restoring a deleted directory.
- **In-app, single-file pivot** via the File Versions View — a
  three-column ItemView (view-type `archivist-file-versions`) that's a
  sister surface to the Backup Browser but pinned to one file. Reach it
  through the *Restore…* entry on the right-click menu in the file
  explorer or the markdown view's more-options menu. The *Show history
  of current file* command still opens the older `FileHistoryModal`,
  not this view.
- **Standalone CLI** (`scripts/restore.mjs`), runs anywhere Node 18+ is
  installed. Works for: breaking the glass when the plugin won't load,
  Obsidian itself is broken, your Dropbox account is locked, or you
  just want a known-good recovery path that doesn't depend on the
  plugin code at all. See `docs/usage.md`.

The CLI runs against the **local** Dropbox-mirrored folder (typically
synced by the Dropbox Desktop app's selective-sync) — it never
authenticates to Dropbox. As long as those files are on your disk, you
can rebuild any snapshot offline.

## Where the data lives, summarized

| Where | What | Synced where? |
|-------|------|----------------|
| `Apps/Archivist/<prefix>/` (Dropbox) | Snapshots, blobs, manifests, HEAD, vault_meta | Dropbox cloud |
| `<vault>/.obsidian/plugins/obsidian-archivist/data.json` | Settings, vault_id, UI state | Obsidian Sync (yes); other vault syncers (yes) |
| Obsidian `app.secretStorage` (id `archivist-dropbox-tokens`) | OAuth tokens (per-machine) | Never — lives in the OS keychain via Electron `safeStorage` (macOS Keychain / Windows DPAPI / Linux libsecret). Out of reach of any vault-replicating sync tool. See ADR-21. |
| `<vault>/.obsidian/plugins/obsidian-archivist/device.json` | device_id + designated flag | Obsidian Sync (no — adapter.write); other vault syncers (yes — exclude if you want per-device state). |
| `<vault>/.obsidian/plugins/obsidian-archivist/index.json` | Local index cache (regeneratable) | Same as device.json |

`device.json` and `index.json` are written via `adapter.write` (not
`plugin.saveData`), so Obsidian Sync ignores them by design. Folder-
replicating sync tools (iCloud, Syncthing, Dropbox Desktop on the vault
folder) don't make that distinction — configure path exclusions if you
want each device to keep its own backup state.

## Going deeper

- `docs/XDD/specs/001-archivist-plugin/solution.md` — the engineering
  spec with all 20 ADRs, sequence diagrams, and crash-recovery proofs.
- `docs/operations/connecting-existing-backup.md` — when adoption /
  vault_id mismatches happen, what to do.
- `docs/troubleshooting/dropbox-corruption.md` — repair commands and
  the bug-report capture flow.
- `docs/usage.md` — the standalone CLI walkthrough.
