# Operations: Retention — what gets kept, what gets pruned

> Archivist takes a snapshot every time something in your vault changes.
> Without a retention policy you'd end up with thousands of them. This
> guide explains the rules Archivist uses to decide which snapshots to
> keep, the safety floor that protects you from misconfiguration, and
> the two command-palette entries that let you preview or run retention
> on demand.

This document is meant to be readable both by humans and by Claude Code
sessions assisting users. Settings labels, command names, and default
values match what you see in Obsidian's settings tab and the command
palette.

## The tier model

Retention works by giving each snapshot a chance to earn a slot in one
of several tiers. A snapshot is kept if at least one tier claims it. If
no tier claims it, it becomes a candidate for pruning.

The tiers, configured under `Settings → Retention`:

- **Recent high-frequency window (hours)** — every snapshot inside this
  rolling window is kept, no questions asked. Default is 24 hours. Use
  this to make sure today's frequent incrementals stay around long
  enough to be useful for "undo what I did this morning" recovery.
- **Never-prune window (days)** — every snapshot inside this rolling
  window is kept too. Default is 14 days. Think of it as a wider blanket
  on top of the recent window: anything from the last two weeks is
  always available, regardless of how the daily and monthly rules
  evaluate it.
- **Daily retention (days)** — once you're past the never-prune window,
  Archivist keeps only the newest snapshot from each calendar day, up
  to this many days back. Default is 30 days. This is what compresses
  yesterday's twenty-three incrementals down to one.
- **Monthly retention (years)** — once you're past the daily window,
  Archivist keeps only the newest snapshot from each calendar month, up
  to this many years back. Default is 3 years.

A tier value of 0 disables that tier. Disabling all tiers and setting
the safety floor to 0 means everything older than the most recent
snapshot will be pruned — that is almost never what you want.

The tiers overlap intentionally. A snapshot taken two hours ago is
kept by the recent window AND the never-prune window AND probably the
daily window. That redundancy is fine — Archivist just needs one
reason to keep a snapshot.

## The safety floor

`Settings → Retention → Always keep most-recent snapshots` is a floor
that protects the N newest snapshots regardless of what the tier rules
say. Default is 3. A value of 0 disables it.

It exists because the tier rules can leave you with nothing if you
combine an aggressive configuration with a quiet day — see the
"no-changes" section below. The floor is a belt to the tier rules'
suspenders: if every tier somehow agrees that nothing needs to stick
around, the floor still keeps your three most recent snapshots.

Raise it if:

- You make small, infrequent changes and want a few extra known-good
  states on hand.
- You've set `Daily retention (days)` to a low number (1 or 2) and want
  insurance against quiet periods.
- You're about to do something risky in the vault and want the next few
  backups to outlive any aggressive cleanup.

Lower it (carefully) only if you're confident in your tier
configuration and you're paying close attention to Dropbox storage.

## Chain integrity

Incremental snapshots reference the snapshot they were taken against.
A January 15 incremental that lives on top of a January 1 full backup
needs both files on Dropbox to be restorable. Archivist will never
delete a snapshot whose data is still needed to reconstruct a kept one.

The practical consequence: some older snapshots stick around even
after their tier slot has expired, because they're holding up the
chain for a newer kept snapshot. You'll see these in the Backup
Browser. They're not bugs; they're load-bearing. They'll be cleaned up
automatically once the snapshot that depended on them is itself
pruned.

## The 24-hour throttle

Archivist runs retention automatically about once a day in the
background. If a previous retention pass ran less than 24 hours ago,
the next scheduled tick skips. This keeps Dropbox API traffic minimal
and avoids re-doing the same work every backup cycle.

The "Run retention now" command bypasses this throttle. Running it
also resets the throttle window — the next scheduled pass is then
gated by the 24-hour rule from that point on.

## Preview retention (dry run)

`Cmd/Ctrl + P → Preview retention (dry run)` evaluates the current
policy against your snapshots and tells you what *would* be pruned,
without touching anything.

It does NOT:

- Delete any snapshot from Dropbox.
- Update the retention timestamp (so the next scheduled run is
  unaffected).
- Trigger the background storage cleanup sweep.

It DOES:

- Compute the keep-set using the current tier settings and the safety
  floor.
- Show a toast summarising "would delete X of Y snapshots". The exact
  snapshot ids appear in Obsidian's developer console — turn on
  `Settings → Advanced → Diagnostic logging` first if you want to see
  them.

Use the dry run before changing tier settings, before raising or
lowering `Always keep most-recent snapshots`, or any time you're
curious which snapshots the current policy considers expendable.

## Run retention now

`Cmd/Ctrl + P → Run retention now (delete)` runs retention immediately,
deletes the metadata for everything outside the keep-set, and kicks
off the background storage cleanup sweep.

What to expect:

- A toast saying "deleted N snapshots" (or "all snapshots kept under
  the current policy" if there was nothing to do).
- The Backup Browser refreshes to reflect the new snapshot list.
- The 24-hour throttle resets.
- A background sweep is queued to actually free up Dropbox space.

If something goes wrong with one or more deletes, the toast says how
many failed. The detail (which ids, which error) is in the developer
console.

This command is useful after you've changed retention settings and
want them applied immediately, or after a long quiet period where
you've accumulated more snapshots than the policy intends.

## The "no-changes" footgun

A backup that finds nothing changed in your vault doesn't create a new
snapshot. That's the right behaviour — no new data means no new
manifest — but it has a non-obvious consequence: today's daily-tier
bucket may still be empty after a successful backup.

Concrete example: you set `Daily retention (days)` to 1 and your vault
is quiet for a day. The "newest snapshot from today" doesn't exist
because no snapshot was created today. The daily tier keeps nothing.
The other tiers expire at their own rates. Without a safety floor, all
your older snapshots would become prunable on the next retention pass.

This is why `Always keep most-recent snapshots` defaults to 3, and why
raising it is the right move if you ever set a daily window of 1 or 2
days. The floor protects you regardless of how the tiers evaluate.

## What about the actual files on Dropbox?

Retention is a metadata-only operation. When a snapshot is pruned, the
plugin removes its manifest from the snapshot index; the content blobs
the manifest referenced may still be on Dropbox if no other snapshot
needs them. The actual space gets reclaimed by a background cleanup
sweep that runs after retention, scanning for content blobs no kept
snapshot references and deleting them.

This split keeps retention fast (one Dropbox delete per snapshot, not
per file) and lets the cleanup run on its own schedule without blocking
the user. If you see Dropbox storage drop minutes or hours after a
retention run rather than instantly, that's why.

If you're investigating an unrelated Dropbox issue and notice a 409
"path not found" response in the developer console right after
retention runs, that's expected — see
`docs/troubleshooting/dropbox-corruption.md` for the benign 409 from
the cleanup sweep's lock probe.

## Related docs

- README's *Retention* section — for the default values and a one-line
  summary of each tier.
- `docs/usage.md` — for how the kept snapshots are surfaced in
  the restore flows.
- `docs/troubleshooting/dropbox-corruption.md` — for recovery from
  Dropbox-side issues, including the benign 409 mentioned above.
