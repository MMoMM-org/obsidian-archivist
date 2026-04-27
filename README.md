# Archivist

Your vault's quiet historian. Versioned vault backups to Dropbox with content-addressed storage, hierarchical retention, and file-level restore.

## What it does

Archivist runs in the background, snapshots your Obsidian vault to Dropbox on a schedule you control, and lets you walk back through every version of every note. When something goes wrong — an accidental delete, a botched merge, a mystery overwrite — you find the version you wanted in the **Backup Browser** or the **Show history of current file** modal, click *Restore*, and the file comes back exactly as it was.

**Who it's for**

- Obsidian users who already pay for Dropbox and want backups that are *theirs* (no third-party service holding your notes).
- Power users who want **per-file version history**, not just whole-vault snapshots.
- Anyone who's been bitten by syncing tools and wants a separate, audit-able backup channel.

**What's different about it**

- **Content-addressed storage**: identical files dedupe automatically. Renaming a 50 MB attachment costs zero new bytes.
- **Hierarchical retention**: high-frequency snapshots in the last 24 h, daily for a month, monthly for years — without you tuning anything.
- **Local-first**: your tokens and indexes live in the vault. The plugin opens exactly three network hosts (listed below) and never phones home elsewhere.
- **Standalone Restore CLI**: a zero-dependency Node script ships in every release. If the plugin or Obsidian ever goes south, you can still recover any file from your Dropbox folder using only `node`.

## Screenshots

> Screenshots will be added at v0.1.0 release. Placeholders:
>
> 1. **Backup Browser** — three-column layout: snapshots (grouped by Today / Yesterday / This week / This month / Older), files at the selected snapshot, and a Markdown preview with Restore controls.
> 2. **File-History modal** — invoke from the command palette on any note. 50 versions per page, rename markers ("Renamed from X on Y"), single-click preview + restore.
> 3. **Settings** — Schedule / Retention / Notifications / Advanced / Dropbox tabs.

## Setup

1. **Install** Archivist (see *Installation* below).
2. **Open Settings → Archivist → Dropbox** and click *Connect Dropbox*. The browser opens, you log in, you authorize the app, and you're returned to Obsidian.
3. **Open Settings → Archivist → Schedule** and toggle *This device backs up the vault* on. Pick the device that will perform backups (only one device per vault should be designated; multiple-device safety is built in but the simplest setup is one designated device).
4. The first **full backup** will run after a 10-minute startup grace + a 2-minute quiet period (configurable). After that, **incrementals** run every 15 minutes when there are changes; **fulls** run weekly by default.

## Dropbox scopes

Archivist requests these Dropbox scopes during OAuth. They are the *minimum* needed for the plugin to function, in line with Dropbox's principle-of-least-privilege guidance.

| Scope | Why we need it |
|-------|----------------|
| `files.content.write` | Upload backup blobs and manifests to the plugin's app folder. |
| `files.content.read` | Download blobs for restore + manifest fetch for history. |
| `files.metadata.read` | List the contents of the app folder (for orphan-blob detection during garbage collection). |
| `account_info.read` | Display the connected account's email in Settings (so you can confirm which account you're connected to). |

The plugin uses the **App Folder** permission model — it can ONLY read or write files inside `Apps/Archivist/<vault-prefix>/` in your Dropbox. It never sees the rest of your Dropbox. This is enforced by Dropbox's OAuth scope, not just by our code.

## Network hosts

Archivist opens connections to these hosts and **only** these hosts. They are declared in `manifest.json` for community-plugin review.

| Host | Purpose |
|------|---------|
| `api.dropboxapi.com` | OAuth token exchange + JSON metadata API. |
| `content.dropboxapi.com` | Binary upload + download. |
| `www.dropbox.com` | OAuth authorization endpoint (browser redirect). |

If you see Archivist contacting any other host, that's a bug — please file it.

## How tokens are stored (read this)

Archivist stores your Dropbox **access token** and **refresh token** in plaintext in a file named `tokens.json` next to the plugin's `data.json`, inside your vault's `.obsidian/plugins/obsidian-archivist/` folder. **Tokens are NOT encrypted at rest.**

This is a deliberate trade-off. Obsidian's plugin API does not expose a system-keychain integration on desktop, and rolling our own would add complexity without meaningfully changing the threat model — anything with read access to your vault folder already has access to your notes.

**Best practices**:

- **Don't share `data.json`, `tokens.json`, or your vault's `.obsidian/` folder with anyone.** Treat them as you would any password file.
- **If you sync your vault** (Obsidian Sync, iCloud, Syncthing, etc.), consider excluding `.obsidian/plugins/obsidian-archivist/` from sync so the tokens don't round-trip between devices. Each device should authorize Dropbox individually.
- **If you suspect a token leak**, click *Disconnect Dropbox* in Settings (this revokes the token server-side) and reconnect. You can also revoke from <https://www.dropbox.com/account/connected_apps>.
- **If you sync the `Apps/Archivist/` folder** (e.g. via the Dropbox Desktop app's selective-sync) consider excluding it locally if disk space is tight — the backup data has nothing useful for live work.

## Migrating from `obsidian-dropbox-backups`

If you previously used [obsidian-dropbox-backups](https://github.com/AvianFlu/obsidian-dropbox-backups) (the predecessor plugin), Archivist will detect it on first load and show a one-time advisory. **Disable the old plugin before enabling Archivist** so the two don't fight over the same Dropbox folder.

Archivist uses a different storage layout (content-addressed blobs + manifests) so old backups are not migrated automatically — they remain in their original Dropbox path until you decide to clean them up.

## Troubleshooting

**"Dropbox disconnected" / Archivist lost access to your account**

This usually means the refresh token was revoked (manually or by inactivity). Open Settings → Archivist → Dropbox and click *Connect Dropbox* again. Your existing backups in Dropbox are NOT affected by re-authenticating.

**"Backups paused — storage cap reached"**

Archivist defaults to a 200 GB hard limit. Either raise the cap (Settings → Retention → *Hard storage limit*) or reduce retention windows (shorter daily/monthly windows). Existing snapshots are not deleted automatically when the cap is reached — backups simply pause until you adjust.

**"Two devices are designated as the backup owner"**

You have two devices both flagged as the designated backup device. Pick one in Settings → Archivist → Schedule → *This device backs up the vault* and toggle the other off. Archivist won't lose data — both devices can read from the same Dropbox folder; only one should write at a time.

**Backups feel slow / are using too much CPU**

Tune Settings → Advanced → *Concurrent uploads* (default 4, range 1–8) and *Upload chunk size* (default 8 MB, range 4–64). Lower values reduce CPU and memory; higher values speed up large file uploads.

**Where do I find logs?**

Archivist logs to Obsidian's developer console (Cmd/Ctrl+Shift+I → Console). Default-mode logs are minimal and contain no path data. To capture verbose logs for a bug report, toggle Settings → Advanced → *Diagnostic logging* on, reproduce the issue, copy the console output, then turn it back off.

## Standalone Restore CLI

In every release, Archivist ships a zero-dependency Node script: `scripts/restore.mjs`. It can read your local Dropbox-mirrored folder (typically synced by the Dropbox Desktop app) and reconstruct any snapshot — without Obsidian, without the plugin, and without an internet connection.

This is your **break-glass recovery tool**. If the plugin breaks, if Obsidian breaks, if Dropbox itself goes down, the data on your disk is enough to recover everything.

**Requirements**: Node 18+ (uses Node-stdlib only — no `npm install`).

**Usage**:

```bash
# List all snapshots in a Dropbox-synced folder, newest first.
node scripts/restore.mjs --input ~/Dropbox/Apps/Archivist/my-vault --list-snapshots

# Restore the latest snapshot to a fresh directory.
node scripts/restore.mjs \
  --input ~/Dropbox/Apps/Archivist/my-vault \
  --output ./restored \
  --at latest

# Restore the version of your vault from 2026-04-20.
node scripts/restore.mjs \
  --input ~/Dropbox/Apps/Archivist/my-vault \
  --output ./restored \
  --at 2026-04-20

# Verify all content blobs hash correctly without writing anything.
node scripts/restore.mjs --input ~/Dropbox/Apps/Archivist/my-vault --verify-only

# Print the file plan without writing.
node scripts/restore.mjs --input ~/Dropbox/Apps/Archivist/my-vault --at latest --dry-run
```

The CLI uses the same chain-merge algorithm as the plugin (verified by parity tests in CI), so output is byte-for-byte identical. Atomic-dir writes mean a partial run leaves no half-restored output.

## Installation

### Community Plugins (after listing)
1. Open Obsidian Settings → Community Plugins
2. Search for "Archivist"
3. Install and enable

### Manual
1. Download `main.js`, `manifest.json`, `styles.css`, and `restore.mjs` from the [latest release](https://github.com/MMoMM-org/obsidian-archivist/releases/latest)
2. Create folder `<vault>/.obsidian/plugins/obsidian-archivist/`
3. Copy `main.js`, `manifest.json`, and `styles.css` into that folder
4. Keep `restore.mjs` somewhere safe — it's your break-glass recovery tool
5. Restart Obsidian and enable the plugin

### BRAT (Beta)
1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat)
2. Add beta plugin: `MMoMM-org/obsidian-archivist`

## Release notes

Per-version changes are tracked in [CHANGELOG.md](CHANGELOG.md). The latest release is also pinned at the top of the [GitHub Releases page](https://github.com/MMoMM-org/obsidian-archivist/releases).

## Issue tracker / contact

Bug reports + feature requests: <https://github.com/MMoMM-org/obsidian-archivist/issues>

When filing a bug, please include:

1. Obsidian version (Settings → About).
2. Archivist version (`manifest.json` in the plugin folder).
3. Operating system + version.
4. A reproduction recipe if possible.
5. **Don't paste your `tokens.json` or `data.json`** — they contain credentials.

Security issues: please email the maintainer (see `package.json` author field) instead of filing a public issue.

## Development

```bash
git clone https://github.com/MMoMM-org/obsidian-archivist.git
cd obsidian-archivist
git config core.hooksPath .githooks
npm install
npm run dev       # Watch mode
npm run build     # Production build
npm test          # Run tests
npm run lint      # Lint
npm run typecheck # TypeScript only
npm audit         # Dependency audit
```

## License

MIT — see [LICENSE](LICENSE).
