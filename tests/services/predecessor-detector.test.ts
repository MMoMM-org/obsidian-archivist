// T7.11 — PredecessorDetector: reconcile banner state with predecessor plugin.

import { describe, expect, it, vi } from 'vitest';
import { PredecessorDetector } from '../../src/services/PredecessorDetector';
import { NoticeCenter } from '../../src/ui/NoticeCenter';
import type { NotificationSettings } from '../../src/model/Settings';
import type { Logger } from '../../src/infra/Logger';
import { S } from '../../src/ui/strings';

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeNotifications(): NotificationSettings {
  return {
    preflight_notice_enabled: true,
    toast_after_inc: false,
    toast_after_full: true,
    toast_on_error: true,
  };
}

function makeNoticeCenter(): NoticeCenter {
  return new NoticeCenter({
    getSettings: () => makeNotifications(),
    notify: () => ({ hide: () => {} }),
    logger: makeLogger(),
  });
}

interface Harness {
  detector: PredecessorDetector;
  noticeCenter: NoticeCenter;
  enabledPlugins: Set<string>;
  isDismissed: { value: boolean };
  recordDismissedCalls: number;
}

function makeHarness(opts: { enabled?: boolean; dismissed?: boolean } = {}): Harness {
  const enabledPlugins = new Set<string>(opts.enabled ? ['obsidian-dropbox-backups'] : []);
  const noticeCenter = makeNoticeCenter();
  const isDismissed = { value: opts.dismissed ?? false };
  let recordDismissedCalls = 0;

  const detector = new PredecessorDetector({
    app: { plugins: { enabledPlugins } },
    noticeCenter,
    isDismissed: () => isDismissed.value,
    recordDismissed: async () => {
      recordDismissedCalls += 1;
      isDismissed.value = true;
    },
  });

  return {
    detector,
    noticeCenter,
    enabledPlugins,
    isDismissed,
    get recordDismissedCalls() {
      return recordDismissedCalls;
    },
  } as Harness;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PredecessorDetector.check', () => {
  it('shows a PREDECESSOR banner when predecessor is enabled AND not dismissed', () => {
    const h = makeHarness({ enabled: true, dismissed: false });
    h.detector.check();
    const banners = h.noticeCenter.getPersistentBanners();
    expect(banners).toHaveLength(1);
    expect(banners[0].code).toBe('PREDECESSOR');
    expect(banners[0].message).toBe(S.PREDECESSOR_NOTICE);
    expect(banners[0].dismissLabel).toBe(S.PREDECESSOR_NOTICE_DISMISS);
    expect(banners[0].onDismiss).toBeDefined();
  });

  it('does NOT show the banner when predecessor is not enabled', () => {
    const h = makeHarness({ enabled: false });
    h.detector.check();
    expect(h.noticeCenter.getPersistentBanners()).toHaveLength(0);
  });

  it('does NOT show the banner when already dismissed', () => {
    const h = makeHarness({ enabled: true, dismissed: true });
    h.detector.check();
    expect(h.noticeCenter.getPersistentBanners()).toHaveLength(0);
  });

  it('clicking Dismiss persists the dismissal flag AND clears the banner', async () => {
    const h = makeHarness({ enabled: true });
    h.detector.check();
    const banner = h.noticeCenter.getPersistentBanners()[0];
    expect(banner.onDismiss).toBeDefined();

    await banner.onDismiss!();
    expect(h.recordDismissedCalls).toBe(1);
    expect(h.noticeCenter.getPersistentBanners()).toHaveLength(0);
    expect(h.isDismissed.value).toBe(true);
  });

  it('auto-clears the banner if predecessor is later disabled (even if the flag is still false)', () => {
    const h = makeHarness({ enabled: true, dismissed: false });
    h.detector.check();
    expect(h.noticeCenter.getPersistentBanners()).toHaveLength(1);

    h.enabledPlugins.delete('obsidian-dropbox-backups');
    h.detector.check();
    expect(h.noticeCenter.getPersistentBanners()).toHaveLength(0);
  });

  it('repeated check calls with unchanged state are idempotent (no duplicate banners)', () => {
    const h = makeHarness({ enabled: true });
    h.detector.check();
    h.detector.check();
    h.detector.check();
    expect(h.noticeCenter.getPersistentBanners()).toHaveLength(1);
  });
});
