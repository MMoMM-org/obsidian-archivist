// Loading placeholder shared by the Backup Browser and File versions views (#140).
//
// Why it exists: Dropbox reads on a large vault (snapshot index, a long
// manifest chain) can take long enough that a bare "Loading…" looks like a
// hang. The placeholder names what is being loaded and, if it is still on
// screen after a few seconds, adds a hint that large vaults take longer.

import { S } from './strings';

/** Delay before the "still working" hint appears under a loading message. */
export const SLOW_LOAD_HINT_MS = 4_000;

/** Schedules a callback; injected so tests can drive it without a window. */
export type ScheduleFn = (fn: () => void, ms: number) => void;

/**
 * Render a loading message into `parent`. With `schedule`, the slow-load
 * hint is appended after SLOW_LOAD_HINT_MS. When the caller has already
 * replaced the placeholder, the hint lands on a detached element and stays
 * invisible, so no cancellation is needed.
 */
export function renderLoading(parent: HTMLElement, message: string, schedule?: ScheduleFn): HTMLElement {
  const el = parent.createEl('p', { text: message, cls: 'archivist-loading' });
  schedule?.(() => {
    el.createSpan({ text: ` ${S.LOADING_SLOW_HINT}`, cls: 'archivist-loading-slow' });
  }, SLOW_LOAD_HINT_MS);
  return el;
}
