# Operations: Connecting the plugin to an existing Dropbox backup

> When you install Archivist into a vault that already has snapshots on
> Dropbox — typically because you re-installed the plugin, moved the
> vault to a new machine, or restored your vault from a non-Archivist
> backup. This guide covers how the plugin claims an existing folder
> safely and what to do when claim-by-default isn't enough.

This document is meant to be readable both by humans and by Claude Code
sessions assisting users. Section headings, exact paths, and the data-
model field names match the runtime behavior.

## How vault identity works

Each vault has two identifiers Archivist cares about:

| Identifier | Where it lives | Purpose |
|------------|----------------|---------|
| `vault_prefix` | `data.json` (per-vault) → `settings.advanced.vault_prefix` | The folder name under `Apps/Archivist/` where this vault's backups live. Default: slug of the Obsidian vault name. |
| `vault_id` | `data.json` (per-vault) → top-level `vault_id`; mirrored to Dropbox at `<prefix>/vault_meta.json` | Stable UUID generated on first plugin load. Survives Obsidian vault renames. Used to verify "this vault owns this Dropbox folder" before each backup write. |

`vault_prefix` answers *where* to read/write. `vault_id` answers *who*
this folder belongs to. Both must agree before the plugin uploads new
snapshots.

## Adoption flow (the common case)

When the plugin loads in a vault and finds:

- Local `data.json` → no `vault_id` (fresh install or after deletion);
- Dropbox `<prefix>/vault_meta.json` → exists with a `vault_id`;

…the plugin shows the **Adopt existing backup** modal:

```
This Dropbox folder belongs to vault_id: 3f2a8c1e-…
The vault on this device does not yet have an ID.

[ ] Adopt — claim this backup for the current vault.
[ ] Cancel — stop here so you can change vault_prefix or pick another folder.
```

If you click **Adopt**, Archivist writes the Dropbox `vault_id` into
the local `data.json`. From then on, every backup-write checks the two
match. Restore continues to work; the inc/full schedule resumes from
where the previous installation left off.

If you click **Cancel**, no local change is made. You can:

- Change `Settings → Advanced → Dropbox vault folder` to a different
  prefix (one that doesn't have a `vault_meta.json`), then run a fresh
  full backup.
- Or click **Adopt** later from the same modal — it appears again on
  every plugin load until the vault is claimed or the prefix is changed.

## Recipes

### Re-installing the plugin in the same vault

Symptom: you removed `obsidian-archivist/` from `.obsidian/plugins/`
(or Obsidian uninstalled it) and now want it back.

1. Reinstall the plugin (community plugins or BRAT).
2. Reconnect Dropbox in settings — the OAuth token is gone with the
   old install.
3. Open Settings → set the same `vault_prefix` you used before.
4. The Adopt modal appears. Click **Adopt**. Done.

The plugin reads `vault_meta.json` from Dropbox, copies the `vault_id`
into the local `data.json`, and continues backing up. Existing
snapshots are visible in the Backup Browser immediately.

### Moving a vault to a new machine

Symptom: same Obsidian vault folder copied (or synced) to a new
device.

If you copied the entire vault including `.obsidian/plugins/obsidian-
archivist/data.json`, the local `vault_id` is already correct — no
adoption modal will appear. Reconnect Dropbox and you're done.

If you only copied the markdown files (clean re-install of the plugin
on the new machine), follow the previous recipe.

### Restoring after a "lost data.json"

Symptom: `data.json` was accidentally deleted (or got corrupted and
Obsidian replaced it with defaults), but the Dropbox folder is intact.

1. Open Settings → set `vault_prefix` to whatever the Dropbox folder
   is named.
2. The Adopt modal appears. Click **Adopt**. Done.

This is the same path as a plugin reinstall — the local plugin lost
its `vault_id`, the Dropbox side still has it.

### Pointing a vault at a *different* vault's backup

We block this in the V1 code paths because it almost always indicates a
mistake. If you are absolutely certain you want to do it (e.g. you are
intentionally consolidating two vaults whose backups should merge), the
manual override is:

1. Edit `data.json` in the target vault and set `vault_id` to the same
   UUID the source vault uses (read it out of the source's `data.json`
   or `<prefix>/vault_meta.json` on Dropbox).
2. Set `vault_prefix` to the source's prefix.

After the next plugin load, both vaults will be writing to the same
folder. Only one of them should be **designated** for backup — the
other should be set to non-designated in `Settings → Advanced` to
avoid two devices uploading divergent state into the same chain.

This is the same constraint that already applies to a single vault
running on multiple machines (see ADR-13).

## Manually editing `vault_id` in `data.json`

You should not normally need to do this — the Adopt modal covers the
common cases. But for the edge cases above, the file location and
field shape are:

```jsonc
// .obsidian/plugins/obsidian-archivist/data.json
{
  "schema_version": "1.0",
  "vault_id": "3f2a8c1e-7d4b-4f12-a1c0-bc5d76e9a2e1",  // ← edit this
  "device": { … },
  "settings": {
    …
    "advanced": {
      …
      "vault_prefix": "test-vault"  // ← and confirm this matches the folder
    }
  }
}
```

Save. Reload Obsidian (or disable + re-enable the plugin in
`Settings → Community plugins`). The plugin re-reads `data.json` on
every load.

## What protections are in place

The vault-isolation work adds three layers of defense, intentional in
this order:

1. **Settings change guard.** When you edit `vault_prefix` in
   Settings, the plugin probes the new prefix on Dropbox before
   accepting the change. If a `snapshot_index.json` already exists at
   that path, you see a confirm dialog with three options: Adopt the
   existing backup (copy `vault_id` from `vault_meta.json`), use the
   new prefix anyway (creates a fresh backup), or cancel.
2. **Pre-write `vault_id` check.** Before every backup upload, the
   plugin compares the local `vault_id` against `vault_meta.json` on
   Dropbox. Mismatch aborts the backup with a clear error and a link
   to this document. This catches the case where the prefix was
   changed via a settings sync but the runtime hadn't reloaded.

If you saw the symptom that motivated this guide — Privat-Test files
showing up in a Test-Vault Backup Browser — see
`docs/troubleshooting/dropbox-corruption.md` for the cleanup recipe.
