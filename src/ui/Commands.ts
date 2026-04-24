// Commands — Obsidian command-palette registrations (T7.5).
//
// Currently registers the manual "Back up now" trigger (PRD S2). Future
// phases add: "Open Backup Browser" (Phase 8) and "Show history of current
// file" (Phase 8).
//
// Design: thin adapters over SchedulerFSM + NotifyFn. No business logic
// beyond mapping a triggerBackupNow() result code to the right user-visible
// Notice copy.

import type { Plugin } from 'obsidian';
import type { SchedulerFSM } from '../services/SchedulerFSM';
import type { NotifyFn } from './NoticeCenter';
import { S } from './strings';

export interface BackupNowCommandDeps {
  plugin: Pick<Plugin, 'addCommand'>;
  fsm: SchedulerFSM;
  notify: NotifyFn;
}

const COMMAND_ID = 'archivist-backup-now';

export function registerBackupNowCommand(deps: BackupNowCommandDeps): void {
  deps.plugin.addCommand({
    id: COMMAND_ID,
    name: S.CMD_BACKUP_NOW,
    callback: () => handleBackupNow(deps),
  });
}

function handleBackupNow(deps: BackupNowCommandDeps): void {
  const result = deps.fsm.triggerBackupNow();
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
