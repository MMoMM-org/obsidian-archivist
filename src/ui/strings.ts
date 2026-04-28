// All user-visible English text. i18n-ready per W9 — V2 localization becomes
// a string-substitution exercise, not a refactor. Do NOT inline English in
// other modules; import S instead.
//
// Keys are UPPER_SNAKE and grouped by surface.

export const S = {
  // ─── Plugin identity ─────────────────────────────────────────────
  PLUGIN_NAME: 'Archivist',
  RIBBON_LABEL: 'Archivist',

  // ─── Ribbon tooltip states ───────────────────────────────────────
  RIBBON_TOOLTIP_IDLE: 'Archivist — idle',
  RIBBON_TOOLTIP_GRACE: 'Archivist — idle · starting soon',
  RIBBON_TOOLTIP_QUIET_WAIT: 'Archivist — idle · waiting for edit activity',
  RIBBON_TOOLTIP_READY: (nextIncLabel: string, nextFullLabel: string): string =>
    `Archivist — next inc ${nextIncLabel} · full ${nextFullLabel}`,
  RIBBON_TOOLTIP_RUNNING: 'Archivist — backup running',
  RIBBON_TOOLTIP_PAUSED: 'Archivist — paused (this device does not back up)',
  RIBBON_TOOLTIP_ERROR: 'Archivist — attention required',
  RIBBON_TOOLTIP_DISCONNECTED: 'Archivist — Dropbox disconnected (reconnect in settings)',

  // ─── Ribbon aria-labels (short, static — color is never the sole signal) ──
  RIBBON_ARIA_IDLE: 'Archivist, idle',
  RIBBON_ARIA_STARTING: 'Archivist, starting soon',
  RIBBON_ARIA_WAITING_QUIET: 'Archivist, waiting for edit activity to settle',
  RIBBON_ARIA_READY: 'Archivist, idle, next backup scheduled',
  RIBBON_ARIA_RUNNING: 'Archivist, backup running',
  RIBBON_ARIA_PAUSED: 'Archivist, paused, this device does not back up',
  RIBBON_ARIA_ERROR: 'Archivist, attention required',
  RIBBON_ARIA_AUTH_LOST: 'Archivist, Dropbox disconnected, reconnect in settings',

  // ─── Commands ────────────────────────────────────────────────────
  CMD_BACKUP_NOW: 'Archivist: Back up now',
  CMD_FULL_BACKUP_NOW: 'Archivist: Run full backup now (recover from corrupt Dropbox state)',

  // ─── Recovery banner ─────────────────────────────────────────────
  CHAIN_RECOVERY_BANNER:
    'Backup chain incomplete on Dropbox. Running a fresh full backup to recover — this may take several minutes.',
  CMD_RESTORE_FILE: 'Archivist: Restore a version of the current file…',
  CMD_OPEN_BACKUP_BROWSER: 'Archivist: Open Backup Browser',
  CMD_OPEN_SETTINGS: 'Archivist: Open settings',
  CMD_SHOW_HISTORY_OF_CURRENT_FILE: 'Archivist: Show history of current file',
  CMD_REPAIR_INDEX: 'Archivist: Repair backup index (rebuild from Dropbox manifests)',
  CMD_GC_ORPHAN_CONTENT: 'Archivist: Garbage collect orphan content',
  CMD_VERIFY_VAULT_OWNERSHIP: 'Archivist: Verify backup ownership',

  // ─── Verify-vault-ownership notifications ────────────────────────
  VERIFY_OWNERSHIP_RUNNING: 'Archivist: checking Dropbox vault ownership…',
  VERIFY_OWNERSHIP_OK: (vaultName: string): string =>
    `Archivist: ownership ok — this device claims "${vaultName}".`,
  VERIFY_OWNERSHIP_FRESH_FOLDER:
    'Archivist: Dropbox folder is empty. The next full backup will claim it for this vault.',
  VERIFY_OWNERSHIP_ADOPT_NEEDED: (remoteName: string): string =>
    `Archivist: this folder belongs to vault "${remoteName}". Adopt or change Dropbox vault folder. Reload Obsidian to see the Adopt dialog.`,
  VERIFY_OWNERSHIP_MISMATCH: (remoteName: string): string =>
    `Archivist: vault id mismatch — this folder belongs to "${remoteName}". Backups are blocked. See docs/troubleshooting/dropbox-corruption.md.`,
  VERIFY_OWNERSHIP_REMOTE_CORRUPT:
    'Archivist: Dropbox vault_meta.json is corrupt. Backups are blocked. Delete vault_meta.json on Dropbox to let the next backup recreate it.',
  VERIFY_OWNERSHIP_FAILED: (msg: string): string =>
    `Archivist: ownership check failed — ${msg}`,

  // ─── Adopt Vault modal (vault-id fingerprint adoption flow) ──────
  ADOPT_VAULT_TITLE: 'Adopt existing Dropbox backup?',
  ADOPT_VAULT_BODY: (remoteName: string, remoteId: string): string =>
    `This Dropbox folder belongs to vault "${remoteName}" (id: ${remoteId}). The vault on this device does not yet have an ID. Adopt to claim this backup for the current vault — backups will resume where the previous installation left off. Cancel to keep this device unclaimed; you can change the Dropbox vault folder in Settings instead.`,
  ADOPT_VAULT_HINT:
    'See docs/operations/connecting-existing-backup.md for when adoption is the right choice.',
  ADOPT_VAULT_ADOPT: 'Adopt',
  ADOPT_VAULT_CANCEL: 'Cancel',

  // ─── Repair-command notifications ────────────────────────────────
  REPAIR_INDEX_RUNNING: 'Archivist: rebuilding backup index from Dropbox…',
  REPAIR_INDEX_OK: (kept: number, removed: number, invalid: number): string => {
    const parts = [`kept ${kept}`];
    if (removed > 0) parts.push(`removed ${removed} phantom${removed === 1 ? '' : 's'}`);
    if (invalid > 0) parts.push(`skipped ${invalid} invalid manifest${invalid === 1 ? '' : 's'}`);
    return `Archivist: backup index rebuilt — ${parts.join(', ')}.`;
  },
  REPAIR_INDEX_FAILED: (msg: string): string =>
    `Archivist: backup index rebuild failed — ${msg}`,
  GC_RUNNING: 'Archivist: garbage-collecting orphan content blobs…',
  GC_OK_SWEPT: (deleted: number, kept: number, ageGated: number): string => {
    const parts = [`deleted ${deleted}`, `kept ${kept}`];
    if (ageGated > 0) parts.push(`${ageGated} age-gated`);
    return `Archivist: GC complete — ${parts.join(', ')}.`;
  },
  GC_OK_NO_INDEX: 'Archivist: GC skipped — snapshot index unreadable. Run "Repair backup index" first.',
  GC_OK_LOCKED: (ageMinutes: number): string =>
    `Archivist: GC skipped — another sweep is in progress (lock age ${ageMinutes} min).`,
  GC_FAILED: (msg: string): string =>
    `Archivist: GC failed — ${msg}`,

  // ─── OAuth ───────────────────────────────────────────────────────
  OAUTH_EMPTY_STATE_TITLE: 'Connect Dropbox to start backing up your vault.',
  OAUTH_EMPTY_STATE_BODY:
    'Archivist stores backups in an app-scoped folder (Apps/Archivist/) and can only read or write within that folder.',
  OAUTH_CONNECT_BUTTON: 'Connect Dropbox',
  OAUTH_NOT_CONNECTED: 'Not connected.',
  OAUTH_CONNECTING: 'Waiting for Dropbox authorization…',
  OAUTH_CONNECTED_AS: (email: string): string => `Connected as ${email}`,
  OAUTH_DISCONNECT_BUTTON: 'Disconnect',
  OAUTH_DISCONNECT_CONFIRM_TITLE: 'Disconnect Dropbox?',
  OAUTH_DISCONNECT_CONFIRM_BODY:
    'This will revoke the plugin\'s access token and remove local credentials. Your existing backups in Dropbox will NOT be deleted.',
  OAUTH_DISCONNECT_CONFIRM_OK: 'Disconnect',
  OAUTH_DISCONNECT_CONFIRM_CANCEL: 'Cancel',
  OAUTH_REAUTH_REQUIRED:
    'Archivist lost access to your Dropbox account. Open settings to reconnect.',
  OAUTH_STATE_MISMATCH: 'Authorization failed — the state parameter did not match. Please try again.',
  OAUTH_TOO_MANY_PENDING_FLOWS: 'Too many pending authorization flows. Please finish or dismiss the current one.',
  OAUTH_REAUTHENTICATE_BUTTON: 'Re-authenticate',
  OAUTH_TRY_AGAIN_BUTTON: 'Try again',
  OAUTH_TOKEN_DISCLOSURE:
    'Tokens are stored in plaintext in tokens.json — outside data.json so Obsidian Sync does not propagate them across devices.',
  OAUTH_TOKEN_DISCLOSURE_LINK_LABEL: 'How tokens are stored →',
  OAUTH_DOCS_URL:
    'https://github.com/MMoMM-org/obsidian-archivist#how-tokens-are-stored-read-this',
  OAUTH_CONNECTED_FALLBACK: 'Dropbox connected.',
  OAUTH_DATA_JSON_SYNC_WARNING:
    'Archivist\'s plugin data appears to be inside an iCloud / Obsidian Sync / Dropbox-synced folder. ' +
    'Consider excluding the plugin folder from that sync to avoid token round-trips between devices.',

  // ─── Pre-flight notice for full backups (F1 / S5) ────────────────
  PREFLIGHT_FULL_TITLE: 'A full backup will start in 5 minutes.',
  PREFLIGHT_FULL_BODY:
    'Full backups take longer than incrementals. You can start it now, postpone for 1 hour, or skip this cycle.',
  PREFLIGHT_START_NOW: 'Start now',
  PREFLIGHT_POSTPONE_1H: 'Postpone 1h',
  PREFLIGHT_SKIP: 'Skip this cycle',

  // ─── Toasts ──────────────────────────────────────────────────────
  TOAST_INC_DONE: (fileCount: number): string =>
    `Incremental backup complete — ${fileCount} file${fileCount === 1 ? '' : 's'} changed.`,
  TOAST_FULL_DONE: 'Full backup complete.',
  TOAST_BACKUP_PAUSED_NO_CHANGES: 'Nothing new to back up.',
  TOAST_ERROR_GENERIC: 'Archivist encountered an error. Check settings for details.',
  TOAST_RESTORE_DONE: 'File restored.',
  TOAST_OFFLINE:
    'Offline — versions known but content unreachable. Reconnect and try again.',
  TOAST_ERRORS_RESOLVED: 'Archivist recovered from recent errors.',

  // ─── Confirm-restore dialog (F3) ─────────────────────────────────
  RESTORE_CONFIRM_TITLE: 'Restore this version?',
  RESTORE_CONFIRM_BODY: (path: string, when: string): string =>
    `This will overwrite "${path}" with the version from ${when}. This cannot be undone.`,
  RESTORE_CONFIRM_OK: 'Restore this version',
  RESTORE_CONFIRM_CANCEL: 'Cancel',
  RESTORE_IN_PROGRESS: 'A restore is already in progress for this file.',

  // ─── ConfirmRestoreModal (T9.3) ──────────────────────────────────
  // CONFIRM_RESTORE_IN_PLACE: standard overwrite confirmation.
  //   path: vault-relative file path being restored.
  //   timestamp: human-readable snapshot timestamp.
  //   size: human-readable file size (e.g. "42 KB").
  CONFIRM_RESTORE_IN_PLACE_TITLE: 'Replace file with this version?',
  CONFIRM_RESTORE_IN_PLACE_BODY: (path: string, timestamp: string, size: string): string =>
    `"${path}" will be replaced with the snapshot from ${timestamp} (${size}). This cannot be undone.`,
  CONFIRM_RESTORE_IN_PLACE_OK: 'Replace',
  CONFIRM_RESTORE_IN_PLACE_CANCEL: 'Cancel',

  // CONFIRM_RESTORE_CREATES_DIR: used when target directory does not exist.
  //   path: vault-relative file path being restored.
  //   timestamp: human-readable snapshot timestamp.
  //   size: human-readable file size.
  //   dirs: comma-separated list of folders that will be created.
  CONFIRM_RESTORE_CREATES_DIR_TITLE: 'Create folders and restore this version?',
  CONFIRM_RESTORE_CREATES_DIR_BODY: (path: string, timestamp: string, size: string, dirs: string): string =>
    `"${path}" will be restored from ${timestamp} (${size}). The following folders will be created: ${dirs}. This cannot be undone.`,
  CONFIRM_RESTORE_CREATES_DIR_OK: 'Replace',
  CONFIRM_RESTORE_CREATES_DIR_CANCEL: 'Cancel',

  // ─── File history modal (F3) ────────────────────────────────────
  FILE_HISTORY_TITLE: 'Version history',
  FILE_HISTORY_EMPTY: 'No backed-up versions found for this file yet.',
  FILE_HISTORY_PREVIEW_BUTTON: 'Preview',
  FILE_HISTORY_RESTORE_BUTTON: 'Restore this version',
  FILE_HISTORY_SHOW_MORE: 'Show 50 more',
  FILE_HISTORY_TIER_DAILY: '[daily]',
  FILE_HISTORY_TIER_MONTHLY: '[monthly]',
  FILE_HISTORY_TIER_NEVER_PRUNE: '[14-day never-prune]',
  FILE_HISTORY_TIER_INITIAL_TODAY: '[initial today]',
  FILE_HISTORY_BINARY_PLACEHOLDER:
    'Binary file — preview not available. Restore to inspect.',
  FILE_HISTORY_NOW_MARKER: '[now]',
  FILE_HISTORY_ONLY_ONE_VERSION: 'Only one version on record.',
  FILE_HISTORY_RENAMED_FROM: (priorPath: string, isoDate: string): string =>
    `Renamed from ${priorPath} on ${isoDate}`,

  // ─── Backup Browser view (F4) ────────────────────────────────────
  BROWSER_TAB_TITLE: 'Backup Browser',
  BROWSER_COL_SNAPSHOTS: 'Snapshots',
  BROWSER_COL_FILES: 'Files at snapshot',
  BROWSER_COL_PREVIEW: 'Preview',
  BROWSER_RESTORE_IN_PLACE: 'Restore in place',
  BROWSER_RESTORE_TO_LOCATION: 'Restore to new location…',
  BROWSER_EMPTY_STATE_TITLE: 'No backups yet.',
  BROWSER_EMPTY_STATE_BODY: (when: string): string =>
    `Your first backup will run at ${when}. Designate this device in settings to enable backups from this machine.`,
  BROWSER_COINSTALLED_PLUGIN_WARNING:
    'Dataview, Templater, or Tasks are enabled. Previews render as plain text to prevent arbitrary code execution from untrusted snapshots.',

  // ─── Backup Browser snapshot groups ─────────────────────────────────
  BROWSER_GROUP_TODAY: 'Today',
  BROWSER_GROUP_YESTERDAY: 'Yesterday',
  BROWSER_GROUP_THIS_WEEK: 'This week',
  BROWSER_GROUP_THIS_MONTH: 'This month',
  BROWSER_GROUP_OLDER: 'Older',

  // ─── Backup Browser loading + error states ───────────────────────────
  BROWSER_LOADING: 'Loading…',
  BROWSER_ERROR_CHAIN_BROKEN:
    'A backup history chain has a missing ancestor. Some snapshots may not be restorable.',

  // ─── Backup Browser tier labels (mirror FILE_HISTORY_TIER_* for use in browser) ─
  BROWSER_TIER_DAILY: '[daily]',
  BROWSER_TIER_MONTHLY: '[monthly]',
  BROWSER_TIER_NEVER_PRUNE: '[14-day never-prune]',

  // ─── Backup Browser directory restore ───────────────────────────────
  BROWSER_DIR_FILE_COUNT: (n: number): string => `${n} file${n === 1 ? '' : 's'}`,
  BROWSER_DIR_NO_FILES_AT_SNAPSHOT:
    'No files in this directory at this snapshot.',
  BROWSER_DIR_RESTORE_IN_PLACE: 'Restore directory in place',
  BROWSER_DIR_RESTORE_AS_COPY: 'Restore directory as copies…',
  BROWSER_CONTEXT_RESTORE_DOTS: 'Restore…',
  CONFIRM_DIR_RESTORE_BODY: (
    dirPath: string,
    timestamp: string,
    fileCount: string,
    mode: string,
  ): string =>
    `Restore ${fileCount} from "${dirPath}" (snapshot ${timestamp}, ${mode}). This cannot be undone.`,
  CONFIRM_DIR_RESTORE_MODE_IN_PLACE: 'overwriting existing files',
  CONFIRM_DIR_RESTORE_MODE_AS_COPY: 'as side-by-side copies',
  TOAST_DIR_RESTORE_OK: (n: number): string =>
    `${n} file${n === 1 ? '' : 's'} restored.`,
  TOAST_DIR_RESTORE_PARTIAL: (ok: number, failed: number): string =>
    `${ok} restored, ${failed} failed. See details in notice center.`,

  // ─── File Versions view (per-file snapshots browser) ─────────────────
  FILE_VERSIONS_TAB_TITLE: 'File Versions',
  FILE_VERSIONS_COL_FILE: 'File',
  FILE_VERSIONS_COL_SNAPSHOTS: 'Versions',
  FILE_VERSIONS_COL_PREVIEW: 'Preview',
  FILE_VERSIONS_EMPTY: 'No backed-up versions found for this file.',
  FILE_VERSIONS_NO_SELECTION: 'Select a version to preview.',
  FILE_VERSIONS_LIVE_LABEL: 'Live vault',
  FILE_VERSIONS_LIVE_MISSING: 'Not in live vault',

  // ─── Multi-device coordination (F5) ──────────────────────────────
  DEVICE_NOT_DESIGNATED_TITLE: 'This device is not the designated backup device.',
  DEVICE_NOT_DESIGNATED_BODY:
    'Backups run on the designated device. To take over, open settings and toggle "This device backs up."',
  DEVICE_TAKEOVER_CONFIRM_TITLE: 'Make this the backup device?',
  DEVICE_TAKEOVER_CONFIRM_BODY:
    'Another device is currently designated for backups. Taking over will stop that device from backing up.',
  DEVICE_TAKEOVER_CONFIRM_OK: 'Take over',
  DEVICE_CONFLICT_BANNER:
    'Two devices are designated as the backup owner. Open settings and choose which device should back up.',

  // ─── Storage limit (F2) ──────────────────────────────────────────
  STORAGE_LIMIT_WARN: (pct: number): string =>
    `Archivist backups are using ${pct}% of the configured storage cap. Consider raising the cap or reducing retention.`,
  STORAGE_LIMIT_HIT_TITLE: 'Backups paused — storage cap reached.',
  STORAGE_LIMIT_HIT_BODY:
    'No new files will be uploaded until you raise the cap or confirm "continue anyway" in settings.',
  STORAGE_LIMIT_CONTINUE_ANYWAY: 'Continue anyway',

  // ─── Predecessor-plugin notice (F8) ──────────────────────────────
  PREDECESSOR_NOTICE:
    'Disable the old plugin before enabling Archivist backups to avoid conflicting uploads.',
  PREDECESSOR_NOTICE_DISMISS: 'Dismiss',

  // ─── Settings sections ───────────────────────────────────────────
  SETTINGS_SECTION_DROPBOX: 'Dropbox account',
  SETTINGS_SECTION_SCHEDULE: 'Schedule',
  SETTINGS_SECTION_RETENTION: 'Retention',
  SETTINGS_SECTION_NOTIFICATIONS: 'Notifications',
  SETTINGS_SECTION_DEVICE: 'This device',
  SETTINGS_SECTION_ADVANCED: 'Advanced',
  SETTINGS_SECTION_DIAGNOSTICS: 'Diagnostics',

  // ─── Settings labels ─────────────────────────────────────────────
  SETTINGS_DESIGNATED_TOGGLE: 'This device backs up the vault',
  SETTINGS_FULL_CADENCE: 'Full backup cadence',
  SETTINGS_FULL_TIME: 'Full backup time (local)',
  SETTINGS_INC_INTERVAL: 'Incremental backup interval',
  SETTINGS_QUIET_PERIOD: 'Quiet period after edits (minutes)',
  SETTINGS_STARTUP_GRACE: 'Startup grace period (minutes)',
  SETTINGS_RETENTION_RECENT_HOURS: 'Recent high-frequency window (hours)',
  SETTINGS_RETENTION_DAILY_DAYS: 'Daily retention (days)',
  SETTINGS_RETENTION_MONTHLY_YEARS: 'Monthly retention (years)',
  SETTINGS_RETENTION_NEVER_PRUNE: 'Never-prune window (days)',
  SETTINGS_STORAGE_HARD_LIMIT: 'Hard storage limit (GB)',
  SETTINGS_STORAGE_WARN_AT: 'Warn at percent of cap',
  SETTINGS_EXCLUSION_GLOBS: 'Exclusion globs',
  SETTINGS_EXCLUSION_GLOBS_HELP:
    'One pattern per line. Supports *, **, ?, and [abc] character classes. Example: .trash/**',
  SETTINGS_DRY_RUN: 'Dry-run mode (no uploads)',
  SETTINGS_DIAGNOSTIC_LOGGING: 'Diagnostic logging (paths visible in logs)',
  SETTINGS_VAULT_PREFIX: 'Dropbox vault folder',
  SETTINGS_VAULT_PREFIX_HELP:
    'Folder name under Apps/Archivist/. Lowercase letters, numbers, hyphens, underscores. Changing this requires restarting Obsidian; if the new folder already has backups from another vault, the next launch shows the Adopt dialog. See docs/operations/connecting-existing-backup.md.',
  SETTINGS_UPLOAD_PARALLELISM: 'Concurrent uploads',
  SETTINGS_CHUNK_SIZE: 'Upload chunk size (MB)',
  SETTINGS_TOAST_AFTER_INC: 'Show toast after incremental backup',
  SETTINGS_TOAST_AFTER_FULL: 'Show toast after full backup',
  SETTINGS_TOAST_ON_ERROR: 'Show toast on error',
  SETTINGS_PREFLIGHT_NOTICE: 'Show pre-flight notice before full backups',
  SETTINGS_RECONCILE_SCAN: 'Enable reconcile scan on startup',
  SETTINGS_STORAGE_ESTIMATE: (bytes: number): string => `Estimated storage in use: ${bytes} bytes`,

  // ─── Backup-now button ───────────────────────────────────────────
  BACKUP_NOW_BUTTON: 'Back up now',
  BACKUP_NOW_IN_PROGRESS: 'Backup already in progress.',
  BACKUP_NOW_NOT_DESIGNATED:
    'This device is not the designated backup device. Designate it in settings to back up from here.',

  // ─── Error copy (error center in settings) ───────────────────────
  ERROR_NETWORK: 'Network error — will retry automatically.',
  ERROR_QUOTA_EXCEEDED: 'Dropbox is out of space for this account.',
  ERROR_RATE_LIMIT: 'Dropbox rate-limited the backup. Retrying shortly.',
  ERROR_MANIFEST_CORRUPT:
    'A backup manifest is corrupt. Archivist will refuse to delete data and will run a new full backup on the next cycle.',
  ERROR_CHAIN_BROKEN:
    'A backup history chain has a missing ancestor. Older versions may not be restorable.',
  ERROR_CONTENT_HASH_MISMATCH:
    'A restored file\'s content hash did not match the manifest. The restore was aborted.',
  ERROR_SCHEMA_INCOMPATIBLE:
    'Settings were saved by a newer version of Archivist. Please upgrade the plugin.',
  ERROR_SETTINGS_MIGRATION_FAILED:
    'Settings could not be migrated. A copy of the old settings was saved as settings.json.bak and defaults are in use.',

  // ─── Dropbox desktop-client overlap notice ───────────────────────
  DROPBOX_DESKTOP_OVERLAP:
    'The Dropbox desktop app appears to sync the Apps/Archivist folder to disk. Consider excluding it from selective sync to avoid duplicate local storage.',

  // ─── Preview pane plugin advisory (T9.4, SEC-H3, ADR-13) ────────────────
  PREVIEW_PLUGIN_ADVISORY:
    'Previewing historical content may execute plugin code (Dataview/Templater/…) the same way as in a live note. The preview runs in your current plugin environment.',
  PREVIEW_PLUGIN_ADVISORY_DISMISS: 'Dismiss',
} as const;

export type StringsKey = keyof typeof S;
