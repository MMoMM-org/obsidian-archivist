# Troubleshooting: Dropbox-side corruption

> When Archivist's view of your backup disagrees with what is actually on
> Dropbox. Most common cause: a previous version of the plugin (or a
> sibling vault) wrote to a Dropbox folder that the current vault now
> claims, leaving stale references behind.

This guide is written so you can hand it to a Claude Code session
verbatim — every section names concrete commands, file paths, and
exit conditions.

## Symptoms

You'll typically notice one of:

1. **Wrong files in the Backup Browser.** A snapshot row exists, but
   clicking it shows files from a different vault than the one you're
   currently using. This is what motivated this guide — see the [Cross-
   vault snapshot](#cross-vault-snapshot) recipe below.
2. **"Backup chain incomplete"** error in the Backup Browser when
   clicking a snapshot whose manifest no longer exists on Dropbox. The
   row stays visible because `snapshot_index.json` still claims it.
3. **Disk usage on Dropbox keeps growing** even though older snapshots
   were pruned by retention. Likely orphan content blobs that the GC
   sweep didn't reach yet.

## The two repair commands

Both live in the Obsidian command palette (`Cmd/Ctrl+P`):

| Command | What it does | When to use |
|---------|--------------|-------------|
| **Archivist: Repair backup index** | Re-derives `<prefix>/snapshot_index.json` from the manifests actually present in `<prefix>/snapshots/`. Removes phantom rows, keeps valid ones. Idempotent. | Symptoms 1 and 2 above. Always safe to run. |
| **Archivist: Garbage collect orphan content** | Triggers `GCService.sweep()` outside the retention schedule. Walks `<prefix>/content/` and deletes blobs no surviving manifest references. Honors `gc_lock` and the 5-minute clock-skew gate. | Symptom 3, or after **Repair backup index** removed phantom snapshots so their content blobs become orphans. |

The repair command **does not** delete manifest files. It only updates
the index. If you need to delete a specific manifest, see the manual
recipes below.

## Vault ID mismatch (after plugin reset)

You see the alert-triangle in the status bar, click it, and the
**Vault identity mismatch** modal opens with two different UUIDs. This
is what the dev console shows just before:

```
[archivist] backup_failed
code: VAULT_ID_MISMATCH
message: Vault identity mismatch: local vault_id <A> does not match
         Dropbox vault_meta.vault_id <B> (registered to "<your-vault>").
```

**Root cause.** The plugin's local `data.json` was reset (most often
because you deleted a duplicate Archivist install while the plugin
folder was shared, or Obsidian replaced the file with defaults after
a partial uninstall). On the next plugin load, `ensureLocalVaultId()`
auto-generates a fresh UUID — but the Dropbox folder still carries
`vault_meta.json` from the previous installation, so local says **A**,
remote says **B**, and the consistency check refuses to overwrite the
remote chain with what looks like a different vault.

**Recovery (the common case).** The previous installation's vault was
the same logical vault (same Obsidian folder, same Dropbox folder,
same content). The remote chain is yours and worth keeping. Click the
status-bar warning triangle:

1. The **Vault identity mismatch** modal opens. Confirm the
   `vault_name` in the remote line matches the vault you're currently
   in (e.g. `(Privat)`).
2. Click **Adopt remote ID**. The plugin overwrites the local
   `vault_id` with the remote one, releases the FSM block, and the
   next backup tick continues the existing chain.

Until you adopt (or change `vault_prefix`), backups stay paused — the
FSM enters a `BLOCKED` state instead of the regular `ERROR` state, so
no retry loop spams the dev console or burns Dropbox round-trips.

**Recovery (the unusual case — different vaults).** If the remote ID
belongs to a DIFFERENT vault that you don't want to merge into:

1. Click **Cancel** on the recovery modal.
2. Open `Settings → Advanced → Dropbox vault folder` and change
   `vault_prefix` to a fresh folder name (one without an existing
   `vault_meta.json`).
3. Reload Obsidian. The plugin claims the new folder on first
   backup, leaving the old one untouched.

**Manual override.** If the modal is unreachable for any reason, the
manual edit recipe in `docs/operations/connecting-existing-backup.md`
under "Manually editing `vault_id` in `data.json`" still works:
disable the plugin, copy the remote `vault_id` from
`<prefix>/vault_meta.json` into local `data.json`, re-enable.

## Cross-vault snapshot

This was the V1 issue: copy the plugin folder (`.obsidian/plugins/
obsidian-archivist/`) from vault A to vault B, then run a backup before
changing the vault prefix in B's settings. Vault B uploads its content
into Vault A's Dropbox folder. Vault A's next chain walk replaces its
state with vault B's content for that one snapshot.

**Confirm it.** Open the Backup Browser, click the suspect snapshot,
and check whether the file paths in the Files column match the
*current* vault. If not, this recipe applies.

**Repair.**

1. Find the snapshot's ID. The Backup Browser shows the timestamp; the
   full ID format is `YYYY-MM-DDThh-mm-(full|inc)` (e.g.
   `2026-04-27T16-09-inc`).
2. On Dropbox web (or any Dropbox client), navigate to
   `Apps/Archivist/<your-vault-prefix>/snapshots/` and delete the file
   whose name matches the suspect ID with a `.json` extension —
   e.g. `2026-04-27T16-09-inc.json`.
3. **In Obsidian**, run **Archivist: Repair backup index**. This rewrites
   `snapshot_index.json` so the deleted manifest no longer appears. You
   should see a notice like `Archivist: backup index rebuilt — kept 12,
   removed 1 phantom`.
4. Run **Archivist: Garbage collect orphan content**. The blobs the
   deleted manifest pointed at — but no surviving manifest references
   — will be swept from `<prefix>/content/`.

After step 4, open the Backup Browser. The suspect row is gone and the
remaining rows show the correct vault's files.

**Note on chain integrity.** If the deleted snapshot was the parent of a
later inc, the chain becomes broken at that join point. The plugin's
existing auto-recovery (see ADRs in `docs/XDD/specs/001-archivist-plugin/
solution.md`) detects this and runs a fresh full backup at the next
opportunity, which re-anchors the chain. You don't need to do anything
manual; the auto-recovery banner will appear in the Backup Browser when
this happens.

## Phantom snapshot row that won't go away

You see a row in the Backup Browser whose timestamp no longer matches
any manifest. Clicking it errors with `BROWSER_ERROR_CHAIN_BROKEN`.

**Root cause.** `snapshot_index.json` claims the ID, but
`<prefix>/snapshots/<id>.json` is missing. The existing
`StartupRecovery.reconcileSnapshotIndex` only handles the reverse case
(manifest exists, index doesn't have it).

**Repair.** Run **Archivist: Repair backup index**. Phantoms are
removed automatically. No manual Dropbox edit needed.

## Disk usage keeps growing

You expect retention to keep storage under the configured cap, but the
Dropbox folder size doesn't shrink after old snapshots are pruned.

**Root cause.** Retention deletes manifests; the actual content blobs in
`<prefix>/content/` are reclaimed by the GC sweep, which is a separate
asynchronous trigger. If the sweep was interrupted (network failure,
plugin disabled mid-sweep) or if `gc_lock` is stuck, blobs can pile up.

**Repair.**

1. Run **Archivist: Garbage collect orphan content**. The notice will
   tell you what it did:
   - `GC complete — deleted N, kept M, K age-gated` — sweep ran.
   - `GC skipped — another sweep is in progress (lock age X min)` —
     a previous sweep is still holding `gc_lock`. If the age is above
     ~30 minutes, the lock is stale; see [Stale GC lock](#stale-gc-lock).
   - `GC skipped — snapshot index unreadable` — run **Repair backup
     index** first, then retry GC.

## Stale GC lock

A previous sweep crashed without removing `<prefix>/gc_lock`. New sweeps
refuse to run until the lock is cleared. The age-gate auto-recovers
after 65 minutes; this section is for the impatient case.

**Repair.** Run **Archivist: Clear stale GC lock** from the command
palette. The notice will tell you whether a lock was actually deleted
or there was nothing to clear. After clearing, run
**Archivist: Garbage collect orphan content** again.

The lock is intentionally checked-then-written; clearing it is safe as
long as you're certain no other Archivist instance is mid-sweep on this
vault. If you'd rather edit Dropbox directly instead, deleting
`Apps/Archivist/<your-vault-prefix>/gc_lock` does the same thing.

## Manual Dropbox surgery (last resort)

You should not normally need to edit `snapshot_index.json` by hand —
the repair command does this safely. But if Dropbox is unreachable from
the plugin (auth lost, account suspended), here's what the file looks
like:

```json
{
  "schema_version": "1.0",
  "last_updated_at": "2026-04-28T10:00:00.000Z",
  "snapshots": [
    {
      "id": "2026-04-26T21-48-full",
      "type": "full",
      "parent_id": null,
      "created_at": "2026-04-26T21:48:26.609Z",
      "device_id": "0d927679-…",
      "blob_hashes": ["…"]
    }
  ]
}
```

To remove an entry, delete the matching object from the `snapshots`
array, bump `last_updated_at` to the current time, save the file. The
plugin will pick up the change on its next read; there is no cache to
invalidate manually.

## What to capture for a bug report

If a repair command runs but the symptom persists, the diagnostic log
has what's needed:

1. Settings → Advanced → enable **Diagnostic logging** (if not
   already on).
2. Open the developer console: **Cmd/Ctrl + Shift + I** → **Console**
   tab. Filter for `[archivist]` to drop unrelated Obsidian logs.
3. Reproduce the issue once.
4. Right-click in the console, *Save as…* (or just copy the relevant
   lines). Look especially for entries prefixed `repair_`, `gc_`,
   `chain_`, or `vault_`.
5. Open an issue at <https://github.com/MMoMM-org/obsidian-archivist/issues>
   with the log and a one-line description of the symptom.

The log entries you're looking for are prefixed `repair_` or
`gc_orphan_content_` — both commands log their start and outcome.
