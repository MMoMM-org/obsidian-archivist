// RibbonIcon — status surface bound to SchedulerFSM state (T7.3).
//
// Rendering strategy (plan/phase-7-mockups.md §Locked decisions / Ribbon):
//   - Base icon `archive-restore` in every state EXCEPT BACKUP_RUNNING.
//   - During BACKUP_RUNNING the icon swaps to `history` and the element gains
//     the `archivist-pulse` class (@keyframes archivist-pulse in styles.css
//     respects prefers-reduced-motion).
//   - Color signal comes from the per-state CSS class on the ribbon element;
//     color is NEVER the only signal — tooltip + aria-label carry the full
//     state name so colorblind and assistive-tech users reach parity.
//
// All DOM operations go through the injected RibbonHost. Production wiring
// (main.ts / T7.12) constructs the real host over `addRibbonIcon` +
// `setIcon` + `setTooltip`; tests pass a recording host.

import type { FSMState, SchedulerFSM } from '../services/SchedulerFSM';
import { formatStatusTooltip, type StatusTooltipInput } from './StatusTooltip';
import { S } from './strings';

// ---------------------------------------------------------------------------
// RibbonHost — DOM boundary, injected for testability
// ---------------------------------------------------------------------------

export interface RibbonHandle {
  setIcon(iconName: string): void;
  setTooltip(tooltip: string): void;
  setAriaLabel(label: string): void;
  setCssClass(cls: string): void;
  destroy(): void;
}

export interface RibbonHost {
  create(params: { icon: string; title: string; onClick: () => void }): RibbonHandle;
}

export interface RibbonIconDeps {
  host: RibbonHost;
  fsm: SchedulerFSM;
  /** Phase 8 replaces this with opening the Backup Browser; stub for now. */
  onRibbonClick?: () => void;
  /**
   * Optional supplier for the live tooltip. When provided, both the visible
   * tooltip and the aria-label use the dynamic formatter (e.g. "next backup
   * in 11 min") instead of the static per-state strings.
   */
  getTooltipInput?: () => StatusTooltipInput;
}

// ---------------------------------------------------------------------------
// Per-state mapping
// ---------------------------------------------------------------------------

interface StatePresentation {
  icon: string;
  cssClass: string;
  tooltip: string;
  aria: string;
}

function presentationFor(state: FSMState): StatePresentation {
  switch (state) {
    case 'LOADING':
      return {
        icon: 'archive-restore',
        cssClass: 'archivist-ribbon archivist-muted',
        tooltip: S.RIBBON_TOOLTIP_IDLE,
        aria: S.RIBBON_ARIA_IDLE,
      };
    case 'GRACE':
      return {
        icon: 'archive-restore',
        cssClass: 'archivist-ribbon archivist-muted',
        tooltip: S.RIBBON_TOOLTIP_GRACE,
        aria: S.RIBBON_ARIA_STARTING,
      };
    case 'QUIET_WAIT':
      return {
        icon: 'archive-restore',
        cssClass: 'archivist-ribbon archivist-muted',
        tooltip: S.RIBBON_TOOLTIP_QUIET_WAIT,
        aria: S.RIBBON_ARIA_WAITING_QUIET,
      };
    case 'READY':
      return {
        icon: 'archive-restore',
        cssClass: 'archivist-ribbon archivist-ready',
        // READY tooltip composition is computed by the caller — see mount()
        // where it's overridden with a live next-inc / next-full label. We
        // fall back to a static idle label if the caller omits it.
        tooltip: S.RIBBON_TOOLTIP_IDLE,
        aria: S.RIBBON_ARIA_READY,
      };
    case 'BACKUP_RUNNING':
      return {
        icon: 'history',
        cssClass: 'archivist-ribbon archivist-running archivist-pulse',
        tooltip: S.RIBBON_TOOLTIP_RUNNING,
        aria: S.RIBBON_ARIA_RUNNING,
      };
    case 'PASSIVE':
      return {
        icon: 'archive-restore',
        cssClass: 'archivist-ribbon archivist-passive',
        tooltip: S.RIBBON_TOOLTIP_PAUSED,
        aria: S.RIBBON_ARIA_PAUSED,
      };
    case 'ERROR':
      return {
        icon: 'archive-restore',
        cssClass: 'archivist-ribbon archivist-error',
        tooltip: S.RIBBON_TOOLTIP_ERROR,
        aria: S.RIBBON_ARIA_ERROR,
      };
    case 'AUTH_LOST':
      return {
        icon: 'archive-restore',
        cssClass: 'archivist-ribbon archivist-error',
        tooltip: S.RIBBON_TOOLTIP_DISCONNECTED,
        aria: S.RIBBON_ARIA_AUTH_LOST,
      };
    case 'BLOCKED':
      return {
        icon: 'shield-alert',
        cssClass: 'archivist-ribbon archivist-blocked',
        tooltip: S.RIBBON_TOOLTIP_BLOCKED,
        aria: S.RIBBON_ARIA_BLOCKED,
      };
  }
}

// ---------------------------------------------------------------------------
// RibbonIcon
// ---------------------------------------------------------------------------

export class RibbonIcon {
  private handle: RibbonHandle | null = null;
  private unsubscribeState: (() => void) | null = null;

  constructor(private readonly deps: RibbonIconDeps) {}

  mount(): void {
    if (this.handle !== null) return; // idempotent — second mount is a no-op
    this.handle = this.deps.host.create({
      icon: 'archive-restore',
      title: S.RIBBON_LABEL,
      onClick: () => this.deps.onRibbonClick?.(),
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
   * Recompute the tooltip without re-reading the FSM state. Caller drives
   * this on a minute tick (countdown progression) and on vault activity
   * (instant feedback that the edit was detected — quiet timer just reset).
   */
  refresh(): void {
    if (!this.handle) return;
    this.applyState(this.deps.fsm.getState());
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private applyState(state: FSMState): void {
    if (!this.handle) return;
    const p = presentationFor(state);
    this.handle.setIcon(p.icon);
    this.handle.setCssClass(p.cssClass);
    const dynamic = this.deps.getTooltipInput
      ? formatStatusTooltip(this.deps.getTooltipInput())
      : null;
    this.handle.setTooltip(dynamic ?? p.tooltip);
    this.handle.setAriaLabel(dynamic ?? p.aria);
  }
}
