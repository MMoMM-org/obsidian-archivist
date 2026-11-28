// Display formatting shared by the Backup Browser and File versions views.
//
// Why it exists: both views show snapshot timestamps side by side with the
// compact `[full]` / `[daily]` tier tags, and they must read identically.
// One formatter keeps the two from drifting (#138).

/**
 * Format a snapshot timestamp for a list row or a confirm dialog.
 *
 * Locale-aware date + 24-hour time, no AM/PM, seconds dropped —
 * `Apr 25, 2026 14:34` (en-US) / `25. Apr. 2026, 14:34` (de-DE). The default
 * `Date.toLocaleString()` produced the long en-US form with seconds and
 * AM/PM, which felt out of place next to the tier tags.
 */
export function formatSnapshotTimestamp(d: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
}
