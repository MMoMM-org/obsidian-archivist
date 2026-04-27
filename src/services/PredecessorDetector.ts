// PredecessorDetector — one-time notice when the legacy
// `obsidian-dropbox-backups` plugin is installed + enabled alongside
// Archivist (T7.11 / PRD F8).
//
// Behaviour (plan §T7.11 test spec):
//   - On onload, check whether the predecessor plugin is enabled via
//     `app.plugins.enabledPlugins.has('obsidian-dropbox-backups')`.
//   - If yes AND the user hasn't clicked "Don't show again": publish a
//     persistent banner via NoticeCenter with a Dismiss button.
//   - If the user dismisses: persist `data.json.ui.predecessor_notice_dismissed
//     = true` and clear the banner.
//   - If the predecessor plugin is later disabled (checked on subsequent
//     calls to `check()`): auto-clear the banner regardless of dismissal.
//
// We run `check()` at plugin onload. Obsidian does not expose a public event
// for plugin enable/disable; a full listener would need internal APIs. V1
// accepts "the banner auto-clears on next plugin reload" as good enough.

import { S } from '../ui/strings';
import type { NoticeCenter } from '../ui/NoticeCenter';

const PREDECESSOR_PLUGIN_ID = 'obsidian-dropbox-backups';
const BANNER_CODE = 'PREDECESSOR';

export interface AppWithPluginRegistry {
  plugins: { enabledPlugins: Set<string> };
}

export interface PredecessorDetectorDeps {
  app: AppWithPluginRegistry;
  noticeCenter: Pick<NoticeCenter, 'showPersistent' | 'clearPersistent'>;
  isDismissed: () => boolean;
  recordDismissed: () => Promise<void>;
}

export class PredecessorDetector {
  constructor(private readonly deps: PredecessorDetectorDeps) {}

  /**
   * Reconcile the banner with current plugin state.
   *   - enabled + !dismissed → show
   *   - enabled + dismissed → clear (user asked not to see it again)
   *   - !enabled → clear (predecessor no longer relevant)
   */
  check(): void {
    const enabled = this.deps.app.plugins.enabledPlugins.has(PREDECESSOR_PLUGIN_ID);

    if (!enabled) {
      this.deps.noticeCenter.clearPersistent(BANNER_CODE);
      return;
    }

    if (this.deps.isDismissed()) {
      this.deps.noticeCenter.clearPersistent(BANNER_CODE);
      return;
    }

    this.deps.noticeCenter.showPersistent(BANNER_CODE, S.PREDECESSOR_NOTICE, {
      dismissLabel: S.PREDECESSOR_NOTICE_DISMISS,
      onDismiss: async () => {
        await this.deps.recordDismissed();
        this.deps.noticeCenter.clearPersistent(BANNER_CODE);
      },
    });
  }
}
