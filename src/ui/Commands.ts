// Commands — Obsidian command-palette registrations (T7.5 / T9.1 / T9.2).
//
// Registers:
//   - "Back up now" (PRD S2) — T7.5
//   - "Open Backup Browser" (PRD F4) — T9.1
//   - "Show history of current file" (PRD F3) — T9.2
//
// Design: thin adapters over service callbacks. No business logic beyond
// routing command invocations to the correct handler.

import type { Plugin } from 'obsidian';
import type { SchedulerFSM } from '../services/SchedulerFSM';
import type { RepairService } from '../services/RepairService';
import type { VaultIdentity } from '../services/VaultIdentity';
import type { Logger } from '../infra/Logger';
import type { NotifyFn } from './NoticeCenter';
import { S } from './strings';

export interface BackupNowCommandDeps {
  plugin: Pick<Plugin, 'addCommand'>;
  fsm: SchedulerFSM;
  notify: NotifyFn;
}

const COMMAND_ID = 'archivist-backup-now';
const COMMAND_ID_FULL = 'archivist-full-backup-now';

export function registerBackupNowCommand(deps: BackupNowCommandDeps): void {
  deps.plugin.addCommand({
    id: COMMAND_ID,
    name: S.CMD_BACKUP_NOW,
    callback: () => handleBackupNow(deps, 'inc'),
  });
  // Manual FULL command: lets users self-recover from a corrupt Dropbox
  // folder (deleted by mistake, replaced from an old backup, etc.) without
  // waiting for the next scheduled full or for the inc-tick auto-fallback.
  deps.plugin.addCommand({
    id: COMMAND_ID_FULL,
    name: S.CMD_FULL_BACKUP_NOW,
    callback: () => handleBackupNow(deps, 'full'),
  });
}

function handleBackupNow(deps: BackupNowCommandDeps, kind: 'inc' | 'full'): void {
  const result = deps.fsm.triggerBackupNow(kind);
  switch (result) {
    case 'started':
      return;
    case 'already_running':
      deps.notify(S.BACKUP_NOW_IN_PROGRESS, { timeout: 4_000 });
      return;
    case 'not_designated':
      deps.notify(S.BACKUP_NOW_NOT_DESIGNATED, { timeout: 6_000 });
      return;
    case 'auth_lost':
      deps.notify(S.OAUTH_REAUTH_REQUIRED, { timeout: 6_000 });
      return;
  }
}

// ---------------------------------------------------------------------------
// Open Backup Browser command (T9.1 / PRD F4)
// ---------------------------------------------------------------------------

export interface OpenBackupBrowserCommandDeps {
  plugin: Pick<Plugin, 'addCommand'>;
  /** Called when the command is invoked; opens or activates the browser view. */
  onOpen: () => void;
}

const OPEN_BROWSER_COMMAND_ID = 'archivist-open-backup-browser';

export function registerOpenBackupBrowserCommand(deps: OpenBackupBrowserCommandDeps): void {
  deps.plugin.addCommand({
    id: OPEN_BROWSER_COMMAND_ID,
    name: S.CMD_OPEN_BACKUP_BROWSER,
    callback: () => deps.onOpen(),
  });
}

// ---------------------------------------------------------------------------
// Show history of current file command (T9.2 / PRD F3)
// ---------------------------------------------------------------------------

export interface ShowHistoryCommandDeps {
  plugin: Pick<Plugin, 'addCommand'>;
  /**
   * Returns the vault-relative path of the currently-active markdown file,
   * or null when no markdown file is active.
   */
  currentFileProvider: () => string | null;
  /** Called when the command fires; receives the current file's path. */
  onOpen: (path: string) => void;
}

const SHOW_HISTORY_COMMAND_ID = 'archivist-show-file-history';

export function registerShowHistoryCommand(deps: ShowHistoryCommandDeps): void {
  deps.plugin.addCommand({
    id: SHOW_HISTORY_COMMAND_ID,
    name: S.CMD_SHOW_HISTORY_OF_CURRENT_FILE,
    checkCallback: (checking: boolean): boolean | void => {
      const path = deps.currentFileProvider();
      if (!path) return false;
      if (!checking) deps.onOpen(path);
      return true;
    },
  });
}

// ---------------------------------------------------------------------------
// Repair commands — user-triggerable recovery actions for Dropbox-side
// corruption. See `docs/troubleshooting/dropbox-corruption.md` for when to
// reach for these.
// ---------------------------------------------------------------------------

export interface RepairCommandsDeps {
  plugin: Pick<Plugin, 'addCommand'>;
  repair: Pick<RepairService, 'rebuildSnapshotIndex' | 'gcOrphanContent' | 'clearGcLock'>;
  notify: NotifyFn;
  logger: Logger;
}

const REPAIR_INDEX_COMMAND_ID = 'archivist-repair-backup-index';
const GC_ORPHAN_CONTENT_COMMAND_ID = 'archivist-gc-orphan-content';
const CLEAR_GC_LOCK_COMMAND_ID = 'archivist-clear-gc-lock';

export function registerRepairCommands(deps: RepairCommandsDeps): void {
  deps.plugin.addCommand({
    id: REPAIR_INDEX_COMMAND_ID,
    name: S.CMD_REPAIR_INDEX,
    callback: () => { void runRepairIndex(deps); },
  });
  deps.plugin.addCommand({
    id: GC_ORPHAN_CONTENT_COMMAND_ID,
    name: S.CMD_GC_ORPHAN_CONTENT,
    callback: () => { void runGcOrphanContent(deps); },
  });
  deps.plugin.addCommand({
    id: CLEAR_GC_LOCK_COMMAND_ID,
    name: S.CMD_CLEAR_GC_LOCK,
    callback: () => { void runClearGcLock(deps); },
  });
}

async function runRepairIndex(deps: RepairCommandsDeps): Promise<void> {
  deps.notify(S.REPAIR_INDEX_RUNNING, { timeout: 4_000 });
  try {
    const result = await deps.repair.rebuildSnapshotIndex();
    deps.notify(
      S.REPAIR_INDEX_OK(
        result.kept.length,
        result.phantomsRemoved.length,
        result.invalidManifests.length,
      ),
      { timeout: 8_000 },
    );
    deps.logger.info('repair_index_command_done', {
      kept_count: result.kept.length,
      phantoms_removed_count: result.phantomsRemoved.length,
      invalid_manifest_count: result.invalidManifests.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.notify(S.REPAIR_INDEX_FAILED(msg), { timeout: 10_000 });
    deps.logger.warn('repair_index_command_failed', { error: msg });
  }
}

async function runClearGcLock(deps: RepairCommandsDeps): Promise<void> {
  try {
    const cleared = await deps.repair.clearGcLock();
    deps.notify(cleared ? S.GC_LOCK_CLEARED : S.GC_LOCK_CLEAR_NONE, { timeout: 6_000 });
    deps.logger.info('clear_gc_lock_command_done', { cleared });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.notify(S.GC_LOCK_CLEAR_FAILED(msg), { timeout: 10_000 });
    deps.logger.warn('clear_gc_lock_command_failed', { error: msg });
  }
}

async function runGcOrphanContent(deps: RepairCommandsDeps): Promise<void> {
  deps.notify(S.GC_RUNNING, { timeout: 4_000 });
  try {
    const result = await deps.repair.gcOrphanContent();
    if (result.state === 'swept') {
      deps.notify(
        S.GC_OK_SWEPT(result.deleted.length, result.kept_count, result.skipped_age_gate),
        { timeout: 8_000 },
      );
    } else if (result.state === 'skipped_no_index') {
      deps.notify(S.GC_OK_NO_INDEX, { timeout: 10_000 });
    } else {
      // skipped_locked — surface the lock age so the user knows whether to
      // wait or to manually remove a stale lock.
      const ageMin = Math.round((result.blocking_lock?.age_ms ?? 0) / 60_000);
      deps.notify(S.GC_OK_LOCKED(ageMin), { timeout: 8_000 });
    }
    deps.logger.info('gc_orphan_content_command_done', { state: result.state });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.notify(S.GC_FAILED(msg), { timeout: 10_000 });
    deps.logger.warn('gc_orphan_content_command_failed', { error: msg });
  }
}

// ---------------------------------------------------------------------------
// Verify-vault-ownership command — on-demand variant of the layout-ready
// consistency probe. Surfaces the current state via toast so users can
// confirm they're set up correctly (or get an actionable message after
// changing vault_prefix in settings).
// ---------------------------------------------------------------------------

export interface VerifyVaultOwnershipCommandDeps {
  plugin: Pick<Plugin, 'addCommand'>;
  vaultIdentity: Pick<VaultIdentity, 'checkConsistency'>;
  notify: NotifyFn;
  logger: Logger;
}

const VERIFY_OWNERSHIP_COMMAND_ID = 'archivist-verify-vault-ownership';

export function registerVerifyVaultOwnershipCommand(
  deps: VerifyVaultOwnershipCommandDeps,
): void {
  deps.plugin.addCommand({
    id: VERIFY_OWNERSHIP_COMMAND_ID,
    name: S.CMD_VERIFY_VAULT_OWNERSHIP,
    callback: () => { void runVerifyOwnership(deps); },
  });
}

async function runVerifyOwnership(deps: VerifyVaultOwnershipCommandDeps): Promise<void> {
  deps.notify(S.VERIFY_OWNERSHIP_RUNNING, { timeout: 4_000 });
  try {
    const result = await deps.vaultIdentity.checkConsistency();
    switch (result.kind) {
      case 'ok':
        deps.notify(S.VERIFY_OWNERSHIP_OK(result.remote.vault_name), { timeout: 6_000 });
        break;
      case 'fresh-folder':
        deps.notify(S.VERIFY_OWNERSHIP_FRESH_FOLDER, { timeout: 6_000 });
        break;
      case 'adopt-remote':
        deps.notify(S.VERIFY_OWNERSHIP_ADOPT_NEEDED(result.remote.vault_name), { timeout: 10_000 });
        break;
      case 'mismatch':
        deps.notify(S.VERIFY_OWNERSHIP_MISMATCH(result.remote.vault_name), { timeout: 10_000 });
        break;
      case 'remote-corrupt':
        deps.notify(S.VERIFY_OWNERSHIP_REMOTE_CORRUPT, { timeout: 10_000 });
        break;
    }
    deps.logger.info('verify_ownership_command_done', { kind: result.kind });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.notify(S.VERIFY_OWNERSHIP_FAILED(msg), { timeout: 10_000 });
    deps.logger.warn('verify_ownership_command_failed', { error: msg });
  }
}
