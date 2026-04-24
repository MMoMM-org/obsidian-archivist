// Commands — Obsidian command-palette registrations (T7.5 / T9.1).
//
// Registers:
//   - "Back up now" (PRD S2) — T7.5
//   - "Open Backup Browser" (PRD F4) — T9.1
//   - "Show history of current file" (PRD F3) — T9.2 (future)
//
// Design: thin adapters over service callbacks. No business logic beyond
// routing command invocations to the correct handler.

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
