# Privacy Policy — Archivist for Obsidian

_Last updated: 2026-05-13. The "Security of local credentials" section was rewritten for ADR-21: Archivist now uses Obsidian's encrypted secret store (Electron `safeStorage`) instead of an on-disk `tokens.json`. Earlier versions of this policy (covering Archivist 0.7.x and earlier) described the plaintext-file behavior._

## TL;DR

Archivist is an offline-first, zero-telemetry Obsidian community plugin. Your vault content is uploaded **only** to **your own** Dropbox account, into a dedicated folder Dropbox sandboxes to Archivist alone. Archivist does not send your data anywhere else, does not phone home, and does not collect usage analytics.

## What Archivist does with your data

- **Your vault content** (Markdown files, attachments, etc.) is hashed with SHA-256 and uploaded via the Dropbox API to `/Apps/Archivist/<your-vault-prefix>/` in **your** Dropbox account. Nothing leaves your device other than to reach your Dropbox.
- **Backup metadata** (file paths, sizes, modification timestamps, snapshot manifests) is stored in the same folder in JSON form.
- **Authentication tokens** (Dropbox OAuth access and refresh tokens) are stored in Obsidian's encrypted secret store (`app.secretStorage`, introduced in Obsidian 1.11.4 and backed by Electron's `safeStorage`). They are **not** written to `data.json`, **not** written to disk as plaintext, and **not** synced by Obsidian Sync. See "Security of local credentials" below for platform-specific encryption guarantees.

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

Archivist stores your Dropbox tokens via Obsidian's `SecretStorage` API (`app.secretStorage`, since Obsidian 1.11.4), under the id `archivist-dropbox-tokens`. Obsidian delegates the actual encryption to Electron's `safeStorage`, and the at-rest guarantee varies by platform:

- **macOS**: A long-lived master key is created in your login Keychain under the entry **"Obsidian Safe Storage"** (kind: `application password`) the first time you launch Obsidian. The encrypted credential blob lives in Obsidian's app-support directory (`~/Library/Application Support/obsidian/`). Decryption requires the master key, which only the Obsidian application bundle has ACL access to; a casual read of the blob from another process or a backup yields ciphertext.
- **Windows**: The master key is encrypted via the user-scoped Windows Data Protection API (DPAPI). The blob is unreadable from a different Windows user account and from a different machine, even with administrative rights, without the original account's login credentials.
- **Linux**: Encryption depends on a working freedesktop secret service (libsecret / GNOME Keyring / KWallet). When that's available, your tokens are encrypted at rest the same way. **When it's not available, Electron's `safeStorage` falls back to basic obfuscation — NOT real encryption.** Linux users without a configured secret service should rely on full-disk encryption to compensate, or be aware that their token is recoverable from disk by anyone who can read their Obsidian app-support directory.

Two important caveats:

- **In-Obsidian process boundary**: Any other plugin running inside the same Obsidian instance can read your token by calling `app.secretStorage.getSecret('archivist-dropbox-tokens')`. Obsidian does not isolate secrets per plugin. Only install plugins from sources you trust, and review the source of plugins that handle sensitive data.
- **Sustained local attacker**: Malware running as your user can in principle extract both the master key (via the keychain API or DPAPI as your user) and the encrypted blob, then decrypt offline. If you suspect a compromise, click **Disconnect Dropbox** in Settings to revoke the refresh token server-side — that immediately renders any leaked copy useless.

## Disconnect and data retention

- Clicking **Disconnect** in Archivist Settings:
  1. Calls Dropbox's `oauth2/token/revoke` endpoint to invalidate the token server-side.
  2. Clears the credentials from Obsidian's secret store by overwriting them with an empty value. (Obsidian's `SecretStorage` API has no per-secret delete operation as of version 1.11.4. The id `archivist-dropbox-tokens` therefore remains visible in **Settings → Secrets** until you remove it from there; the value is empty.)
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
