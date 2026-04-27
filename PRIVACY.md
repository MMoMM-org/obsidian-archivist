# Privacy Policy — Archivist for Obsidian

_Last updated: 2026-04-23. This is a pre-release stub; it will be expanded before V1 public release._

## TL;DR

Archivist is an offline-first, zero-telemetry Obsidian community plugin. Your vault content is uploaded **only** to **your own** Dropbox account, into a dedicated folder Dropbox sandboxes to Archivist alone. Archivist does not send your data anywhere else, does not phone home, and does not collect usage analytics.

## What Archivist does with your data

- **Your vault content** (Markdown files, attachments, etc.) is hashed with SHA-256 and uploaded via the Dropbox API to `/Apps/Archivist/<your-vault-prefix>/` in **your** Dropbox account. Nothing leaves your device other than to reach your Dropbox.
- **Backup metadata** (file paths, sizes, modification timestamps, snapshot manifests) is stored in the same folder in JSON form.
- **Authentication tokens** (Dropbox OAuth access token and refresh token) are stored in plain text in the plugin's local data folder (`<vault>/.obsidian/plugins/obsidian-archivist/tokens.json`). See "Security of local credentials" below.

## What Archivist does NOT do

- **No telemetry.** No usage events, crash reports, or analytics are sent anywhere. The plugin does not call any domain other than Dropbox.
- **No third-party tracking.** No advertising IDs, cookies, or fingerprinting.
- **No sharing.** Archivist never invites anyone to anything. The Dropbox scopes requested do not include `sharing.*` or `account_info.*`.
- **No access to the rest of your Dropbox.** The Dropbox app is registered in "App folder" mode, which restricts it to `/Apps/Archivist/` regardless of what our code does. Archivist cannot read or modify any other file in your Dropbox account.

## Dropbox permissions requested

When you connect Archivist to Dropbox, the OAuth consent screen will ask you to grant three scopes, all limited to the `/Apps/Archivist/` folder:

| Scope | Why |
|---|---|
| `files.content.write` | Upload backups; delete them during retention/garbage-collection |
| `files.content.read` | Download files when you restore |
| `files.metadata.read` | List which backups exist |

You can revoke access at any time via Dropbox's own app settings page (https://www.dropbox.com/account/connected_apps) or by clicking Disconnect in the plugin's Settings.

## Security of local credentials

Your Dropbox refresh token is stored in plaintext at `<vault>/.obsidian/plugins/obsidian-archivist/tokens.json`. On desktop, Archivist sets file permissions to 600 (owner-read-only) where the platform allows it. This file is **not** stored in `data.json` specifically so that Obsidian Sync does NOT synchronize it across your devices — each device authenticates separately.

If your plugin data folder is itself synced by another tool (iCloud Drive, Obsidian Sync configured for plugin data, Dropbox Desktop syncing your whole home directory, …), that tool will see your refresh token. Archivist warns you once if it detects such a path; we cannot defeat it for you. A local attacker with filesystem read access can use a stolen refresh token to access your backup data until you revoke it on Dropbox.

## Disconnect and data retention

- Clicking **Disconnect** in Archivist Settings:
  1. Calls Dropbox's `oauth2/token/revoke` endpoint to invalidate the token server-side.
  2. Deletes the local `tokens.json`.
  3. Does **NOT** delete any backup data in your Dropbox — that is your data and your decision.
- If you want to delete your backup history, go to `/Apps/Archivist/` in Dropbox and delete it yourself. Archivist does not do this automatically.
- Uninstalling the plugin does not delete your Dropbox backups.

## Dependencies and supply chain

Archivist uses the official `dropbox` npm SDK. The full list of bundled dependencies is visible in the plugin's `package-lock.json` in the repository. We run `npm audit` on every release; security issues in dependencies are tracked as part of the release checklist.

## Open source

- Source code: https://github.com/MMoMM-org/obsidian-archivist
- Issue tracker: https://github.com/MMoMM-org/obsidian-archivist/issues
- License: MIT

## Contact

Privacy-relevant bug reports: open an issue at the tracker above, or email `marcus@breiden.net`.

## Changes to this policy

Any changes to this policy will be announced in the release notes and in the project CHANGELOG.md. The Dropbox OAuth Privacy Policy URL points at this file in the `main` branch of the repository — readers can view history via GitHub's blame/history UI.
