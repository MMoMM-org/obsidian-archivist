# Future Features

> Backlog of post-V1 enhancements that have a clear motivating use case but
> are intentionally deferred. Add here when a feature emerges from a real
> user need but doesn't justify shipping in the current cycle. Remove the
> entry when shipped (link the PR in the commit that drops the line).

## Backup chain corruption — UX polish

Two follow-ups to the auto-recovery work in PRs #9 / #11. The detection +
fall-back-to-FULL flow handles the data layer; these items address how the
*surviving orphan snapshots* surface in the UI.

### Orphan tag in Backup Browser

**Problem.** After a chain-break + auto-recovered FULL, the orphaned inc
snapshots remain in `snapshot_index.json` (correct — historical record). They
appear in the Backup Browser like any other snapshot, but clicking them
produces the `BROWSER_ERROR_CHAIN_BROKEN` message because their parent chain
can't be walked. Users see a plausible-looking row that errors on click —
confusing.

**Proposed change.** Tag snapshots in the Backup Browser whose `parent_id`
chain doesn't reach a Full. Show a small `[orphaned]` chip next to the date
(same visual slot as the existing `[inc]` / `[full]` tags). On click, render
a friendlier explanation than the generic chain-broken message: *"This
snapshot's parent chain is no longer available on Dropbox. The new Full
snapshot above replaces it."*

**Rough scope.** Walk the chain up-front for each visible snapshot when the
browser opens (cache the result). Add an `orphaned: boolean` field to the
in-memory snapshot row model. Pre-compute on browser-open instead of
per-click so the UI doesn't lag.

**Effort estimate.** ~30 min of code + tests.

### Soft-prune option for orphan snapshots

**Problem.** Orphan inc snapshots stay in `snapshot_index.json` forever
(unless the user runs the standalone restore CLI to clean up by hand).
Long-lived vaults will accumulate orphans across the years.

**Proposed change.** Add a setting *"Auto-remove orphan snapshots after N
days"* (default off, range 7–365). When enabled, the maintenance scheduler
removes snapshot_index entries whose chain doesn't reach a Full and whose
`created_at` is older than N days. Manifests + content blobs stay on Dropbox
— let the existing GC sweep them when nothing references them anymore.

**Rough scope.** New `RetentionService` pass: orphan-detection + age-gate +
snapshot_index rewrite. Settings UI toggle + numeric input. No Dropbox
deletes from this pass — purely an index cleanup.

**Effort estimate.** ~1–2 h of code + tests + settings wiring. Wait until at
least one real user (not the dev) reports accumulated orphans being
annoying — premature otherwise.
