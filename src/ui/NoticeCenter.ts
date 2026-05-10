// NoticeCenter — user-visible notification routing + dedup + persistent-banner
// observable (T7.4).
//
// Responsibilities:
//   - Route success / error / preflight events to Obsidian `Notice`, gated by
//     NotificationSettings toggles (inc / full / error / preflight).
//   - Dedup repeated errors within a 5-minute window per error code (bursty
//     networks must not produce 20 toasts; one per burst is enough).
//   - Emit a single "resumed" notice on the first success after any error
//     burst — tells the user the plugin has recovered.
//   - Track persistent banners (QuotaExceeded, AuthLost, DeviceConflict,
//     StorageLimit) as observable state consumed by SettingsTab + RibbonIcon.
//   - Satisfy the SchedulerFSM `PreflightHost` contract by rendering the
//     pre-flight notice with Start-now / Postpone-1h / Skip actions.
//
// Design invariants:
//   - Rendering is delegated to an injected `notify` function — the class has
//     ZERO direct Obsidian imports. Production wiring (main.ts / T7.12)
//     provides the real Notice factory; tests pass a recording collector.
//   - Persistent banners are a Map keyed by code — showing the same code
//     twice updates the message in place; one banner per code.
//   - Error-burst flag is a single boolean (intentional). If three error
//     codes all burst, one "resumed" notice covers the recovery.

import type { NotificationSettings } from '../model/Settings';
import type { Logger } from '../infra/Logger';
import type { PreflightActions, PreflightHost } from '../services/SchedulerFSM';
import { S } from './strings';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SuccessEvent = { type: 'inc'; fileCount: number } | { type: 'full' };

export interface PersistentBanner {
  code: string;
  message: string;
  /** Optional user-dismiss hook — if present, the banner renders a Dismiss control. */
  onDismiss?: () => void | Promise<void>;
  dismissLabel?: string;
}

export interface ShowPersistentOptions {
  onDismiss?: () => void | Promise<void>;
  dismissLabel?: string;
}

export interface NoticeButton {
  label: string;
  onClick: () => void;
}

export interface NotifyOptions {
  timeout?: number;
  buttons?: NoticeButton[];
}

/**
 * Handle returned by `notify()` so callers can dismiss the notice
 * programmatically. Required for sticky notices (timeout: 0) — without it,
 * the only way to clear the notice is a user click.
 */
export interface NoticeHandle {
  hide(): void;
}

export type NotifyFn = (message: string, opts?: NotifyOptions) => NoticeHandle;

export type BannerSubscriber = (banners: PersistentBanner[]) => void;

export interface NoticeCenterDeps {
  getSettings: () => NotificationSettings;
  notify: NotifyFn;
  logger: Logger;
  /** Injectable for tests — defaults to Date.now(). */
  now?: () => number;
}

const ERROR_DEDUP_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_TOAST_TIMEOUT_MS = 5_000;
const ERROR_TOAST_TIMEOUT_MS = 8_000;
const PERSISTENT_TIMEOUT = 0; // sticky in Obsidian Notice

function formatHHmm(epochMs: number): string {
  const d = new Date(epochMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// NoticeCenter
// ---------------------------------------------------------------------------

export class NoticeCenter implements PreflightHost {
  private readonly now: () => number;
  private readonly errorLastSeen = new Map<string, number>();
  private readonly banners = new Map<string, PersistentBanner>();
  private bannerSubscribers: BannerSubscriber[] = [];
  private errorBurstActive = false;
  /**
   * Handle for the currently visible preflight notice, if any. The notice is
   * sticky (timeout: 0), so we keep this reference to dismiss it from
   * button handlers and from `dismissPreflight()` (called by the FSM when
   * the scheduled full has run).
   */
  private currentPreflightHandle: NoticeHandle | null = null;

  constructor(private readonly deps: NoticeCenterDeps) {
    this.now = deps.now ?? ((): number => Date.now());
  }

  // ---------------------------------------------------------------------------
  // Success / error routing
  // ---------------------------------------------------------------------------

  showSuccess(event: SuccessEvent): void {
    const settings = this.deps.getSettings();

    // Resumed-from-error notice fires BEFORE the success toast so the user
    // sees the recovery context first. Always fires (not gated by toast
    // toggles) because it carries independent signal — "the plugin is healthy
    // again" — that users want even when routine success toasts are muted.
    if (this.errorBurstActive) {
      this.deps.notify(S.TOAST_ERRORS_RESOLVED, { timeout: DEFAULT_TOAST_TIMEOUT_MS });
      this.errorBurstActive = false;
    }

    if (event.type === 'inc') {
      if (!settings.toast_after_inc) return;
      this.deps.notify(S.TOAST_INC_DONE(event.fileCount), {
        timeout: DEFAULT_TOAST_TIMEOUT_MS,
      });
    } else {
      if (!settings.toast_after_full) return;
      this.deps.notify(S.TOAST_FULL_DONE, { timeout: DEFAULT_TOAST_TIMEOUT_MS });
    }
  }

  showError(code: string, _detail?: string): void {
    const settings = this.deps.getSettings();
    if (!settings.toast_on_error) return;

    const last = this.errorLastSeen.get(code);
    const now = this.now();
    if (last !== undefined && now - last < ERROR_DEDUP_WINDOW_MS) {
      return; // inside the burst window — suppress
    }

    this.errorLastSeen.set(code, now);
    this.errorBurstActive = true;
    this.deps.notify(messageForErrorCode(code), { timeout: ERROR_TOAST_TIMEOUT_MS });
  }

  // ---------------------------------------------------------------------------
  // Persistent banners (state — not Obsidian Notice)
  // ---------------------------------------------------------------------------

  showPersistent(code: string, message: string, opts?: ShowPersistentOptions): void {
    const existing = this.banners.get(code);
    if (
      existing &&
      existing.message === message &&
      existing.onDismiss === opts?.onDismiss &&
      existing.dismissLabel === opts?.dismissLabel
    ) {
      return; // idempotent
    }
    this.banners.set(code, {
      code,
      message,
      onDismiss: opts?.onDismiss,
      dismissLabel: opts?.dismissLabel,
    });
    this.emitBanners();
  }

  clearPersistent(code: string): void {
    if (this.banners.delete(code)) this.emitBanners();
  }

  getPersistentBanners(): PersistentBanner[] {
    return Array.from(this.banners.values());
  }

  subscribePersistentBanners(handler: BannerSubscriber): () => void {
    this.bannerSubscribers.push(handler);
    return (): void => {
      this.bannerSubscribers = this.bannerSubscribers.filter((s) => s !== handler);
    };
  }

  // ---------------------------------------------------------------------------
  // Preflight (PreflightHost contract)
  // ---------------------------------------------------------------------------

  showPreflight(actions: PreflightActions, scheduledAt: number): void {
    const settings = this.deps.getSettings();
    if (!settings.preflight_notice_enabled) {
      // User has disabled the preflight notice. The FSM calls this host
      // unconditionally; we silently drop the call. The scheduled full will
      // still fire at its scheduled time (5 min after the preflight window
      // opened) via the FSM's normal tick path.
      return;
    }

    // Replace any stale preflight (e.g. from a prior scheduled cycle the
    // user never interacted with) so we never stack two visible notices.
    this.dismissPreflight();

    const wrap = (cb: () => void) => (): void => {
      this.dismissPreflight();
      cb();
    };

    const body = `${S.PREFLIGHT_FULL_TITLE(formatHHmm(scheduledAt))}\n\n${S.PREFLIGHT_FULL_BODY}`;
    this.currentPreflightHandle = this.deps.notify(body, {
      timeout: PERSISTENT_TIMEOUT,
      buttons: [
        { label: S.PREFLIGHT_START_NOW, onClick: wrap(actions.onStartNow) },
        { label: S.PREFLIGHT_POSTPONE_1H, onClick: wrap(actions.onPostpone1h) },
        { label: S.PREFLIGHT_SKIP, onClick: wrap(actions.onSkip) },
      ],
    });
  }

  dismissPreflight(): void {
    const handle = this.currentPreflightHandle;
    if (handle === null) return;
    this.currentPreflightHandle = null;
    handle.hide();
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private emitBanners(): void {
    const snapshot = this.getPersistentBanners();
    for (const h of this.bannerSubscribers.slice()) h(snapshot);
  }
}

// ---------------------------------------------------------------------------
// Error-code → message mapping (module-scope so it stays pure)
// ---------------------------------------------------------------------------

function messageForErrorCode(code: string): string {
  switch (code) {
    case 'NETWORK':
      return S.ERROR_NETWORK;
    case 'QUOTA_EXCEEDED':
      return S.ERROR_QUOTA_EXCEEDED;
    case 'RATE_LIMIT':
      return S.ERROR_RATE_LIMIT;
    case 'MANIFEST_CORRUPT':
      return S.ERROR_MANIFEST_CORRUPT;
    case 'CHAIN_BROKEN':
      return S.ERROR_CHAIN_BROKEN;
    case 'CONTENT_HASH_MISMATCH':
      return S.ERROR_CONTENT_HASH_MISMATCH;
    case 'SCHEMA_INCOMPATIBLE':
      return S.ERROR_SCHEMA_INCOMPATIBLE;
    case 'SETTINGS_MIGRATION_FAILED':
      return S.ERROR_SETTINGS_MIGRATION_FAILED;
    default:
      return S.TOAST_ERROR_GENERIC;
  }
}
