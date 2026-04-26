// StatusBar — companion to RibbonIcon. Mirrors the FSM state in Obsidian's
// bottom status bar with an icon + short label, so users have a second
// always-visible signal regardless of whether the ribbon column is collapsed.
//
// Same DOM-boundary pattern as RibbonIcon (injected host) so the wiring stays
// testable without spinning up real Obsidian DOM.

import type { FSMState, SchedulerFSM } from '../services/SchedulerFSM';
import { formatStatusTooltip, type StatusTooltipInput } from './StatusTooltip';
import { S } from './strings';

// ---------------------------------------------------------------------------
// StatusBarHost — DOM boundary, injected for testability
// ---------------------------------------------------------------------------

export interface StatusBarHandle {
  setIcon(iconName: string): void;
  setLabel(text: string): void;
  setAriaLabel(label: string): void;
  setCssClass(cls: string): void;
  destroy(): void;
}

export interface StatusBarHost {
  create(params: { onClick: () => void }): StatusBarHandle;
}

export interface StatusBarDeps {
  host: StatusBarHost;
  fsm: SchedulerFSM;
  /** Click handler — typically opens the Backup Browser, same as ribbon. */
  onClick?: () => void;
  /**
   * Optional supplier for the live tooltip. When provided, the aria-label
   * uses the dynamic formatter (e.g. "next backup in 11 min") instead of
   * the static per-state string. Should be cheap to call — invoked on every
   * state transition and every refresh().
   */
  getTooltipInput?: () => StatusTooltipInput;
}

// ---------------------------------------------------------------------------
// Per-state mapping
// ---------------------------------------------------------------------------

interface StatePresentation {
  icon: string;
  cssClass: string;
  label: string;
  aria: string;
}

function presentationFor(state: FSMState): StatePresentation {
  switch (state) {
    case 'LOADING':
    case 'GRACE':
    case 'QUIET_WAIT':
      return {
        icon: 'archive',
        cssClass: 'archivist-status archivist-muted',
        label: 'Archivist',
        aria: S.RIBBON_ARIA_IDLE,
      };
    case 'READY':
      return {
        icon: 'archive',
        cssClass: 'archivist-status archivist-ready',
        label: 'Archivist',
        aria: S.RIBBON_ARIA_READY,
      };
    case 'BACKUP_RUNNING':
      return {
        icon: 'history',
        cssClass: 'archivist-status archivist-running archivist-pulse',
        label: 'Backing up…',
        aria: S.RIBBON_ARIA_RUNNING,
      };
    case 'PASSIVE':
      return {
        icon: 'pause',
        cssClass: 'archivist-status archivist-passive',
        label: 'Archivist (paused)',
        aria: S.RIBBON_ARIA_PAUSED,
      };
    case 'ERROR':
      return {
        icon: 'alert-triangle',
        cssClass: 'archivist-status archivist-error',
        label: 'Archivist (attention)',
        aria: S.RIBBON_ARIA_ERROR,
      };
    case 'AUTH_LOST':
      return {
        icon: 'unplug',
        cssClass: 'archivist-status archivist-error',
        label: 'Reconnect Dropbox',
        aria: S.RIBBON_ARIA_AUTH_LOST,
      };
  }
}

// ---------------------------------------------------------------------------
// StatusBar
// ---------------------------------------------------------------------------

export class StatusBar {
  private handle: StatusBarHandle | null = null;
  private unsubscribeState: (() => void) | null = null;

  constructor(private readonly deps: StatusBarDeps) {}

  mount(): void {
    if (this.handle !== null) return; // idempotent — second mount is a no-op
    this.handle = this.deps.host.create({
      onClick: () => this.deps.onClick?.(),
    });
    this.applyState(this.deps.fsm.getState());
    this.unsubscribeState = this.deps.fsm.onStateChange((next) => this.applyState(next));
  }

  unmount(): void {
    this.unsubscribeState?.();
    this.unsubscribeState = null;
    this.handle?.destroy();
    this.handle = null;
  }

  /**
   * Recompute the tooltip without re-reading the FSM state. Call this on a
   * minute tick so the countdown stays current, and immediately on vault
   * activity so the user sees the timer reset as evidence the edit landed.
   */
  refresh(): void {
    if (!this.handle) return;
    this.applyState(this.deps.fsm.getState());
  }

  private applyState(state: FSMState): void {
    if (!this.handle) return;
    const p = presentationFor(state);
    this.handle.setIcon(p.icon);
    this.handle.setLabel(p.label);
    this.handle.setCssClass(p.cssClass);
    const aria = this.deps.getTooltipInput
      ? formatStatusTooltip(this.deps.getTooltipInput())
      : p.aria;
    this.handle.setAriaLabel(aria);
  }
}
