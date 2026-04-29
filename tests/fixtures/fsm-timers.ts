// Timer fns for SchedulerFSM tests. The FSM no longer falls back to bare
// setTimeout/clearTimeout (obsidianmd/prefer-active-window-timers) — every
// caller must inject. Tests inject these wrappers so vi.useFakeTimers() can
// intercept.

import type { SetTimeoutFn, ClearTimeoutFn } from '../../src/services/SchedulerFSM';

export const testSetTimeoutFn: SetTimeoutFn = (fn, ms) => setTimeout(fn, ms);
export const testClearTimeoutFn: ClearTimeoutFn = (h) =>
  clearTimeout(h as ReturnType<typeof setTimeout>);
