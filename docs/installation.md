# Installation

> Walks a first-time user through installing Archivist on their Obsidian vault,
> verifying the installation, and knowing when to update.

## Prerequisites

- **Obsidian 1.11.4 or newer** (minimum app version, per `manifest.json`).
- **Desktop only.** Archivist is marked `isDesktopOnly: true`. Mobile Obsidian
  (iOS / Android) is not supported.
- **A Dropbox account.** Archivist uses Dropbox's *App Folder* permission model
  and stores backups under `Apps/Archivist/<vault-prefix>/`. A free account is
  enough to start; storage usage depends on vault size and retention settings.
- **Network access** to three Dropbox hosts: `api.dropboxapi.com`,
  `content.dropboxapi.com`, and `www.dropbox.com`. These are declared in
  `manifest.json` for community-plugin review.

## Install from Community Plugins

1. In Obsidian, open **Settings → Community plugins**.
2. Make sure **Restricted mode** is off (this is Obsidian's name for the
   safe-by-default state that blocks third-party plugins).
3. Click **Browse** and search for `Archivist`.
4. Click **Install**, wait for the download to finish, then click **Enable**.

A new ribbon icon (an archive-restore glyph) appears on Obsidian's left
sidebar, and the **Archivist** entry shows up under
**Settings → Community plugins → Installed plugins**.

## Install manually

For pre-release builds or when you want to pin a specific version:

1. Open the [GitHub Releases page](https://github.com/MMoMM-org/obsidian-archivist/releases).
2. Download `main.js`, `manifest.json`, and `styles.css` from the version
   you want.
3. Copy the three files into `<your-vault>/.obsidian/plugins/archivist/`.
   Create the `archivist` folder if it doesn't exist.
4. In Obsidian, open **Settings → Community plugins**, scroll to
   **Installed plugins**, find Archivist, and toggle it on. If Archivist was
   already enabled, disable + re-enable so the new build is picked up.

The release artifacts ship with attested provenance — verify with
`gh attestation verify <file> --owner MMoMM-org` if you want to confirm the
bytes came from the GitHub Actions release workflow.

Each release also bundles `restore.mjs` — the standalone Restore CLI. The
plugin doesn't need it at runtime, but you'll want it on hand if you ever
need to recover data without Obsidian. Keep it somewhere stable (next to
your other recovery tools); see [docs/usage.md](usage.md) for the CLI
walkthrough.

## Install via BRAT (unreleased main builds)

[BRAT](https://github.com/TfTHacker/obsidian42-brat) installs plugin
builds from a GitHub repository's `main` branch — useful for chasing a
fix that has landed but hasn't been tagged yet. Not recommended for
everyday use; the Community Plugins channel covers that.

1. Install BRAT from Community Plugins.
2. **Settings → BRAT → Add Beta plugin** and paste
   `MMoMM-org/obsidian-archivist`.

Already running via BRAT and want to switch to the official channel?
You can do so without losing settings, backup history, or the Dropbox
connection: disable Archivist in Obsidian, remove it from BRAT's Beta
Plugin List (decline if BRAT offers to delete the plugin files — your
`data.json`, `index.json`, etc. live there), then install Archivist
from Community Plugins. The plugin ID is identical in both channels,
so all local data and SecretStorage tokens survive the switch.

## Verify the installation

After enabling, check that all three surfaces are reachable:

1. **Ribbon icon.** A new archive-restore icon appears on Obsidian's left
   sidebar.
2. **Settings tab.** **Settings → Archivist** shows the five-section
   panel (Dropbox account, Schedule, Retention, Notifications, Advanced).
3. **Command palette.** Open the palette (**Cmd/Ctrl + P**) and search for
   `Archivist:` — you should see entries like *Back up now*, *Open Backup
   Browser*, and the retention commands. See
   [docs/commands-reference.md](commands-reference.md) for the full list.

If you connect Dropbox under **Settings → Archivist → Dropbox account** and
the first full backup runs successfully, you can also confirm the folder
`Apps/Archivist/<vault-prefix>/` appears in your Dropbox account.

For the full first-time setup flow (designated device, Dropbox OAuth, vault
folder name), see the **Setup** section of the [root README](../README.md).

## Updating

Community Plugins installs update through Obsidian:

1. Open **Settings → Community plugins → Installed plugins**.
2. Click the **Check for updates** button at the top.
3. Updated plugins show an **Update** button — click it and Obsidian
   reloads the plugin in place.

Manual installs update by repeating the **Install manually** steps with a
newer release.

Archivist follows semantic versioning. Patch and minor updates ship
without migration steps. Major updates that require user action (e.g.
breaking changes to `data.json` format) ship a release note describing
the migration; check the [CHANGELOG](../CHANGELOG.md) before a major
upgrade.

## Next steps

- [Configuration](configuration.md) — every setting documented.
- The **Setup** section of the [root README](../README.md) — designated
  device, Dropbox OAuth, vault folder name, first backup.
- [Usage](usage.md) — restore flows.
- If you're pointing Archivist at a folder that already has backups
  from another install, see
  [docs/operations/connecting-existing-backup.md](operations/connecting-existing-backup.md).
