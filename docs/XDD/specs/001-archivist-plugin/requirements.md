---
title: "Archivist — Versioned Obsidian Vault Backups to Dropbox"
status: draft
version: "1.0"
---

# Product Requirements Document

## Validation Checklist

### CRITICAL GATES (Must Pass)

- [x] All required sections are complete
- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Problem statement is specific and measurable
- [x] Every feature has testable acceptance criteria (Gherkin format)
- [x] No contradictions between sections

### QUALITY CHECKS (Should Pass)

- [x] Problem is validated by evidence (not assumptions)
- [x] Context → Problem → Solution flow makes sense
- [x] Every persona has at least one user journey
- [x] All MoSCoW categories addressed (Must/Should/Could/Won't)
- [x] Every metric has corresponding tracking events
- [x] No feature redundancy (check for duplicates)
- [x] No technical implementation details included
- [x] A new team member could understand this PRD

---

## Product Overview

### Vision

Archivist is the Obsidian plugin that lets a user recover *any* version of *any* note in *any* vault, in under 30 seconds, without ever having to open a cloud file browser — so they can write fearlessly, knowing their vault's history is always one click away.

### Problem Statement

The Obsidian community has converged on a single Dropbox-backup plugin — `obsidian-dropbox-backups` (informally "Aut-O-Backups") — as the default answer to "how do I back up my vault?". The plugin is **unmaintained since June 2024** and has three concrete, measurable failure modes that hit every real user within weeks:

1. **Unbounded storage growth.** It uploads a full backup every 20 minutes with zero retention. A 2 GB vault produces ~144 GB/day of duplicated payload. Users who follow the default configuration hit Dropbox storage limits within 7–14 days.
2. **No configuration.** Backup interval, retention, and active windows are hard-coded. Users who want less aggressive cadence must fork the plugin.
3. **No restore path.** To recover a file, users must open Dropbox's web UI, manually sift through hundreds of unlabeled full-backup snapshots, and guess which one predates the mistake they are trying to undo. The plugin does not surface *which file changed when* anywhere in Obsidian itself.

Combined with inherited technical debt (vendored SDK, no tests, uncaught async rejections), the situation forces every serious Obsidian user who wants offsite backup into one of three bad outcomes: pay for more Dropbox storage, give up on backup plugins entirely, or write their own tooling. There is no good default.

**Consequence of not solving:** users lose work. A typical failure mode — a note corrupted by a sync conflict, an accidental delete, or a faulty bulk operation — goes unnoticed for hours or days. By the time it's discovered, the user either (a) can't find the right snapshot in the hundreds available, or (b) has already lost the snapshot because Dropbox hit its storage cap and the user deleted history to recover.

### Value Proposition

Archivist is built around a single promise: **"What was this file before I broke it?"** must be answerable in three clicks. Every design decision serves that promise.

Against the incumbent (`obsidian-dropbox-backups`): Archivist ships configurable cadence, hierarchical retention that provably does not fill up a reasonable Dropbox plan, and a native in-Obsidian browser that replaces the "open Dropbox web, guess a timestamp" workflow with a direct file-history lookup for the currently-open note.

Against doing nothing (manual backups, Git, Obsidian Sync alone): Archivist adds versioned history with file-level restore that Obsidian Sync does not provide, without requiring any command-line or Git literacy, and without coupling backup to the same provider that holds the live vault.

Against alternative tooling (rsync scripts, cloud sync folders, third-party backup services): Archivist integrates with Obsidian's event model, respects its file abstractions, and presents history through Obsidian's own UI conventions — users never leave the app.

## User Personas

### Primary Persona: Marcus the Serious Note-Taker

- **Demographics:** 30–50 years old, technical professional (software, research, consulting), intermediate-to-advanced Obsidian user. 10k+ notes accumulated over 3+ years. Uses Obsidian daily for both personal and professional knowledge work. Comfortable configuring plugins; not interested in writing code to solve backup.
- **Goals:**
  - Never lose a note, even one edited a week ago and forgotten about.
  - Recover a specific earlier version of a note without reading a manual.
  - Run backups quietly in the background; never think about them until something goes wrong.
  - Keep Dropbox usage at or below 5% of the user's plan (the V1 design target stated in Constraints) — backups should be invisible both in UX and in the Dropbox account.
- **Pain Points:**
  - Burned previously by `obsidian-dropbox-backups` filling up Dropbox within days.
  - Has opened Dropbox web to find the right snapshot and been unable to tell which of 300 `backup-2024-06-14-14-32-00/` folders contains the pre-corruption version.
  - Does not trust Obsidian Sync alone (Obsidian Sync retains versions for 1 year but recovery UX is opaque and it's the same provider holding the live vault — single point of failure).

### Secondary Persona: Alex the Multi-Device User

- **Demographics:** Same technical profile as Marcus; writes from 2+ devices (desktop + mobile, or desktop + laptop). Uses Obsidian Sync, iCloud, or Syncthing to keep devices in agreement.
- **Goals:** Same as Marcus, plus: backup runs from exactly one device (the most "always-on" one). Doesn't want two devices racing to upload overlapping snapshots. Wants to browse and restore history from any device — including the phone when the laptop is elsewhere.
- **Pain Points:**
  - External sync tools (Obsidian Sync, iCloud, Dropbox desktop app) modify file mtimes during sync; naïve backup plugins interpret this as "all files changed" and re-upload everything.
  - No current plugin lets them declare "this is the backup device"; they have to disable the plugin manually on secondary devices.

## User Journey Maps

### Primary User Journey: Recover a File I Broke Yesterday

1. **Awareness:** Marcus opens a daily note he edited yesterday. Sees it's half-empty — a merge conflict earlier today clobbered the bottom half.
2. **Consideration:** He realizes any note-recovery answer must be *fast* — if it takes more than a minute or two, he'll give up and rewrite from memory. He discards "open Dropbox web" immediately.
3. **Adoption:** Opens the Command Palette, types "history," finds `Archivist: Show history of current file`. Modal opens.
4. **Usage:** Sees 8 versions listed with timestamps and sizes. The 09:00 version is marked "[initial today]" — before the merge conflict. Clicks "Preview" → sees the correct content. Clicks "Restore this version" → file replaced after a one-line confirmation.
5. **Retention:** Next week, a similar incident happens. Marcus goes straight to the command palette. He now trusts Archivist as a safety net; he edits more boldly because undo extends beyond Obsidian's per-session history.

### Secondary User Journey: Set Up Archivist on a New Device (Multi-Device Case)

1. **Awareness:** Alex just installed Obsidian on a new laptop. His primary desktop already runs Archivist. He wants history to be browsable here too, without two devices racing.
2. **Consideration:** He recalls Archivist has a "This device performs backups" toggle.
3. **Adoption:** Installs Archivist. Opens settings. Sees the toggle is off by default — good.
4. **Usage:** Leaves the toggle off. Completes Dropbox OAuth (needed for read-only browsing of history). Verifies in the Backup Browser that his desktop's snapshots appear. Closes settings.
5. **Retention:** Weeks later, desktop is in a different city. Needs to recover a note. Opens Archivist Backup Browser on laptop, restores. Mentally notes: "Archivist is my recovery tool on any device, not just the backup owner."

### Secondary User Journey: First-Time Setup

1. **Awareness:** Marcus reads the README, installs the plugin from Community Plugins.
2. **Consideration:** On enable, sees a first-run notice in settings: "Connect Dropbox to start backing up your vault."
3. **Adoption:** Clicks "Connect Dropbox." Browser opens, PKCE flow completes in Dropbox's page, redirects back to Obsidian. Plugin confirms "Connected as marcus@…".
4. **Usage:** Reviews defaults (weekly full Sunday 03:00, 15-min incrementals, 14-day never-prune window). Leaves them. Toggles "This device performs backups" on. Closes settings.
5. **Retention:** 10 minutes later, quiet-period expires; first full backup runs silently. A toast confirms completion. Marcus does not think about Archivist again for two weeks, until he needs to recover a note.

## Feature Requirements

### Must Have Features

#### Feature 1: Automatic Incremental + Full Backups with Quiet-Period Protection

- **User Story:** As a serious note-taker, I want backups to run automatically on a schedule without interrupting my writing, so that I don't have to remember to trigger them.
- **Acceptance Criteria (Gherkin Format):**
  - [ ] Given the plugin is enabled and this device is designated as the backup device, When 15 minutes pass with pending changes in the queue, Then an incremental backup runs and completes without any user interaction.
  - [ ] Given the plugin is enabled and the 15-minute interval elapses with zero pending changes, When the interval fires, Then no network calls are made (the empty tick is a no-op).
  - [ ] Given the plugin is just loaded (Obsidian startup), When the first backup opportunity arises, Then no backup runs for at least 10 minutes (grace period) AND not until at least 2 minutes have elapsed since the last vault event (quiet-period).
  - [ ] Given it is Sunday 03:00 local time and this device is the designated backup device, When the scheduled full backup fires, Then a notice appeared 5 minutes prior offering Start now / Postpone 1h / Skip, and if no action was taken, the full backup ran.
  - [ ] Given a scheduled full was overdue (device was offline at the scheduled time), When the device comes online and completes grace/quiet periods, Then the overdue full runs as a catch-up job.

#### Feature 2: Hierarchical Retention that Caps Storage Growth

- **User Story:** As a user with a 2 TB Dropbox plan, I want the plugin to keep recent snapshots densely and older snapshots sparsely, so that my Dropbox account does not fill up and my history stays navigable.
- **Acceptance Criteria:**
  - [ ] Given the plugin is running with default retention settings (never-prune 14d, recent 24h, hourly 7d, daily 30d, weekly 6mo, monthly 3y), When 35 days have passed in a test fixture, Then the number of retained snapshots matches the tier math to within ±1 snapshot.
  - [ ] Given a snapshot is within the configured never-prune window, When any retention pass runs, Then the snapshot is kept regardless of which other tier rules would otherwise prune it.
  - [ ] Given a retention pass deletes a snapshot manifest, When garbage collection runs afterwards, Then content blobs referenced by zero remaining manifests are deleted from Dropbox AND content blobs referenced by at least one remaining manifest are retained.
  - [ ] Given a user configures a tier value (e.g., daily = 60 days), When the retention pass runs, Then the new value is honored on the next pass with no manual restart required.
  - [ ] Given the total Dropbox usage for Archivist exceeds a configurable warning threshold (default 80% of a user-settable limit), When the plugin detects this after a backup, Then the user sees a persistent warning in Settings and the ribbon tooltip.
  - [ ] Given the total Dropbox usage for Archivist meets or exceeds 100% of the configured hard-limit, When the next scheduled backup is about to run, Then backups are paused (the cycle does not upload), a persistent banner surfaces in Settings + ribbon tooltip, and no `files/upload` calls are issued until the user either raises the limit or confirms "continue anyway" via a Settings control.

#### Feature 3: File-Level Restore via Command Palette (Primary Recovery Path)

- **User Story:** As a user who just noticed a note is broken, I want to open a version list of the currently-open file and restore an earlier version, so that I can recover in under 30 seconds without leaving Obsidian.
- **Acceptance Criteria:**
  - [ ] Given a file is open in the editor AND Archivist has at least one prior version of that file, When the user invokes the `Archivist: Show history of current file` command, Then a modal opens within 2 seconds listing all retained versions with timestamp, size, and tier tag.
  - [ ] Given the version list is displayed, When the user selects a version and clicks Preview, Then the version's content renders in the modal (for text files) within 3 seconds.
  - [ ] Given the user has selected a version to restore in place, When they confirm the destructive action via the confirmation dialog, Then the live file is overwritten with the selected version's content AND the restored content's SHA-256 matches the hash recorded in the manifest for that version.
  - [ ] Given the currently-open file has exactly one retained version (never changed since first backup), When the user invokes the command, Then the modal shows a clear "Only one version on record" message and the single entry, rather than hiding the modal.
  - [ ] Given the file has been renamed during its history, When the user invokes the command, Then versions under previous paths are included in the list with a visual marker showing the prior path and rename date.

#### Feature 4: Backup Browser Tab (Power-User Recovery Path)

- **User Story:** As a user recovering from a broader incident (e.g., a folder was accidentally deleted), I want to browse any prior snapshot by date and pick individual files to restore, so that I can recover without knowing the filename in advance.
- **Acceptance Criteria:**
  - [ ] Given the user invokes `Archivist: Open Backup Browser` OR clicks the second ribbon button, When the view opens, Then a three-column layout appears (snapshot list / files-at-snapshot / preview) within 1 second.
  - [ ] Given the user selects a snapshot in column 1, When the selection is made, Then column 2 populates with the file tree of that snapshot within 3 seconds for a 10k-file vault.
  - [ ] Given the user selects a file in column 2, When the selection is made, Then column 3 displays a preview (text) or a binary-file placeholder within 3 seconds.
  - [ ] Given the selected file is a binary file (non-text extension or detected-binary content), When column 3 renders, Then the preview area shows a "binary file — no text preview (<size>)" placeholder AND the Restore actions remain enabled.
  - [ ] Given the user clicks "Restore in place" in column 3 and the file's path no longer exists in the live vault, When the action is confirmed, Then the file is restored at its original path (creating intermediate folders if needed), the user sees a confirmation of folder creation, and the restored content matches the snapshot's recorded hash.
  - [ ] Given no backups exist yet, When the Backup Browser is opened, Then it shows an empty-state message explaining when the first backup will run and how to confirm this device is the backup device.

#### Feature 5: Multi-Device Designated-Owner Coordination

- **User Story:** As a user on two devices, I want exactly one device to perform backups while the other browses history read-only, so that I don't get duplicate or conflicting snapshots.
- **Acceptance Criteria:**
  - [ ] Given two devices both have Archivist installed and authenticated, When both have the "This device performs backups" toggle off, Then neither device uploads anything AND both can browse history.
  - [ ] Given one device has the toggle on and another has it off, When a backup cycle runs on the "on" device, Then the "off" device shows a "passive" state in its ribbon tooltip and uploads nothing.
  - [ ] Given a user manually switches ownership (toggles off on device A, on on device B), When device B next runs its backup cycle, Then device B completes its backup successfully and the manifest records device B's device-ID.
  - [ ] Given two devices are both erroneously set to "on" at the same time, When the second device starts a backup, Then it detects the conflict via recent-other-device evidence in the Dropbox folder AND refuses to proceed AND surfaces a clear error telling the user which device is the other active one.

#### Feature 6: Robustness Against External Sync Tools

- **User Story:** As a user whose vault is also synced by Obsidian Sync / iCloud / Syncthing / Dropbox desktop / Git, I want Archivist to correctly detect files that changed through those channels, so that my history isn't missing entries and I don't get spurious re-uploads.
- **Acceptance Criteria:**
  - [ ] Given a file was modified by an external sync tool (not Obsidian itself) while the plugin was running, When the next backup cycle fires, Then the reconcile scan detects the change and the file is included in the incremental.
  - [ ] Given a file was modified by an external sync tool while Obsidian was closed, When Obsidian is reopened and the plugin completes grace + quiet period, Then the reconcile scan detects the change and the file is included in the next backup.
  - [ ] Given an external sync tool updates a file's mtime without changing content (common iCloud / Obsidian Sync behavior), When the reconcile scan runs, Then the content hash is used as the final authority and the file is NOT re-uploaded if its content is unchanged.

#### Feature 7: Dropbox OAuth Flow with Secure Disconnect

- **User Story:** As a first-time user, I want to authorize Dropbox access in a way that obviously only gives the plugin access to its own folder, so that I can trust the plugin with my vault.
- **Acceptance Criteria:**
  - [ ] Given Archivist is newly installed and enabled, When the user opens Settings, Then the Dropbox section shows an empty-state CTA with copy explaining the App-Folder scope and a [Connect Dropbox] button.
  - [ ] Given the user clicks [Connect Dropbox], When they complete the PKCE flow in their browser, Then the plugin confirms "Connected as \<email\>" in Settings and no access token is visible in the UI.
  - [ ] Given the user cancels the OAuth flow mid-way (closes browser tab), When they return to Settings, Then the plugin is in the disconnected state and offers [Try again] without leaking half-completed auth state.
  - [ ] Given the user clicks [Disconnect], When they confirm the disconnect dialog, Then the plugin (a) calls the Dropbox token-revoke endpoint, (b) deletes the local access and refresh tokens, and (c) does NOT delete the backup data in Dropbox.
  - [ ] Given the user's Dropbox access token has been revoked server-side (e.g., from Dropbox's app settings), When the next backup cycle attempts an API call, Then the plugin surfaces a persistent "authentication lost — reconnect" notice and does not retry infinitely.

#### Feature 8: First-Run Awareness of Predecessor Plugin

- **User Story:** As a user migrating from `obsidian-dropbox-backups`, I want a clear warning if I enable Archivist while the old plugin is still active, so that I don't end up with two plugins uploading conflicting data.
- **Acceptance Criteria:**
  - [ ] Given the user enables Archivist AND the plugin `obsidian-dropbox-backups` is currently installed and enabled, When Archivist completes its first load, Then a one-time notice is shown: "Disable the old plugin before enabling Archivist backups to avoid conflicting uploads."
  - [ ] Given the user dismisses the predecessor-plugin notice, When they re-enable Archivist in a later session, Then the notice does not re-appear.

### Should Have Features

- **S1. Exclusion Globs.** Users can exclude paths via glob (e.g., `.trash/**`, `_templates/**`) from backup. Existing manifests are unaffected; only snapshots taken after the setting change apply the exclusion. Default: empty list.
- **S2. Manual "Back up now" Trigger.** Ribbon button and command-palette command force an immediate incremental backup on the designated device (desktop) or the only device (mobile, if manual-backup-on-mobile is enabled).
- **S3. Storage Usage Estimate in Settings.** Settings page shows current Dropbox usage for the Archivist folder and a computed retention estimate ("With these settings: ~120 snapshots, estimated ~40 GB"). Updated after each backup.
- **S4. Mobile Restore (Read-Only).** On mobile, the Backup Browser and File-History modal work as on desktop (collapsed to single-column on narrow viewports). Scheduling is desktop-only.
- **S5. Pre-Flight Notice for Full Backups.** 5-minute-before-full notice with Start now / Postpone 1h / Skip. Configurable on/off.
- **S6. Standalone Restore CLI (`scripts/restore.mjs`).** A single-file Node.js script with zero npm dependencies that reconstructs any snapshot from a locally-available `Apps/Archivist/` folder (commonly the Dropbox Desktop app's synced copy — any local mirror with the same layout works) — WITHOUT requiring the plugin to be installed or Obsidian to be running. Rationale: disaster recovery + "trust but verify" + future-proofing if the plugin is ever abandoned. User invokes `node scripts/restore.mjs --dropbox-path <path> --output <dir> [--at <id|latest|date>] [--list-snapshots] [--dry-run] [--verify-only]`. The script verifies every blob's SHA-256 before writing and produces byte-identical output to the plugin's in-app restore.
- **Acceptance Criteria (S6):**
  - [ ] Given a local `Apps/Archivist/<VAULT_PREFIX>/` folder with N snapshots, When the user invokes `--list-snapshots`, Then stdout lists all N snapshots with id, type, parent_id, and created_at, sorted newest-first.
  - [ ] Given a valid snapshot chain, When the user invokes `--at latest --output OUT`, Then the reconstructed directory matches the plugin's in-app restore for the same snapshot byte-for-byte.
  - [ ] Given any content blob's SHA-256 does not match its manifest hash, When the CLI encounters it during restore, Then the CLI exits non-zero BEFORE writing the bad file, the in-progress output directory is cleaned up (atomic-dir pattern), and stdout lists every offending path.
  - [ ] Given `--dry-run`, When invoked, Then the CLI prints the would-write list (paths + sizes + hashes) and writes zero files, exit 0.
  - [ ] Given `--verify-only`, When invoked on a clean fixture, Then exit 0; When invoked on a fixture with a corrupted blob, Then exit non-zero with the offending hash listed.
  - [ ] The script is a single `.mjs` file with zero `import` statements from npm packages (Node ≥ 18 stdlib only — asserted by a grep-based CI gate).

### Could Have Features

- **C1. "Restore as Copy" Variant.** Instead of overwriting in place, restore saves as `<path>.restored-<timestamp>.md` next to the original (or at the original path if the original is gone).
- **C2. Copy Content to Clipboard.** Third action in the Backup Browser preview pane.
- **C3. Dry-Run Mode.** Setting that logs what would be uploaded/deleted without actually doing it. Useful for validating retention config.
- **C4. Configurable Active Window.** Restrict incrementals to a user-specified time range (e.g., 08:00–22:00) to avoid running during off-hours. Full backups ignore this window.
- **C5. Toast Notifications After Each Successful Backup.** Off by default (would fire every 15 min on an active device); on for full-backup completion; on for errors.

### Won't Have (This Phase)

- **W1. Full-Vault Restore (Wipe + Replace).** Disaster recovery — wipe the live vault and replace with a snapshot. Deferred due to blast-radius risk and need for a separate confirmation UX; users can currently achieve this manually by selecting all files in a snapshot and restoring each.
- **W2. Dynamic Device Takeover.** Automatic detection that device A has been silent for N hours and promotion of device B. V1 requires manual toggle switching.
- **W3. Timeline Visualization of Snapshots.** A graphical timeline showing all snapshots with density — deferred in favor of the list-based Backup Browser for V1.
- **W4. Diff Viewer Between Snapshot Versions.** Line or word diff between two versions of the same file; V1 is preview-based comparison only.
- **W5. Export Snapshot as Zip.** Local download of an entire snapshot as a zip archive.
- **W6. Alternative Storage Backends (S3, Google Drive).** Dropbox only in V1.
- **W7. Full-Text Search Over Historical Snapshots.** V1 browsing is by timestamp + file path only.
- **W8. Automatic Client-Side Encryption.** Trade-off with content-addressed deduplication is unresolved; Dropbox account compromise is explicitly out-of-scope V1. Deferred.
- **W9. Localization.** English-only V1; strings centralized to make V2 localization a straightforward retrofit.
- **W10. Automatic Migration from `obsidian-dropbox-backups`.** Old backups remain in the old Dropbox folder untouched. V1 shows a deactivation-reminder notice only.
- **W11. Binary-Diff Incrementals for Large Binaries.** Full CAS blob per byte change is accepted for V1 given the target vault profile (mostly markdown).
- **W12. Large-Vault Support Beyond 20k Files.** V1 is calibrated for vaults up to 20,000 files. Reconcile-scan performance beyond that is untested and may degrade.

## Detailed Feature Specifications

### Feature: File-Level Restore via Command Palette

**Description:** The primary recovery path. A user who realizes a note was damaged — via a sync conflict, an accidental edit, a rogue bulk-operation — opens the Command Palette, runs `Archivist: Show history of current file`, sees a chronological list of retained versions of the currently-open file with timestamp, size, and tier tag, picks a version, previews it, and either restores it in place or saves it as a copy. The entire flow is designed to complete in ≤ 30 seconds of user time for a 5-day-old version.

**User Flow:**
1. User is editing a file and notices it is damaged.
2. User invokes the Command Palette (default Cmd/Ctrl+P).
3. User types "history" and selects `Archivist: Show history of current file`.
4. System opens a modal with the version list, sorted newest → oldest, with the currently-live version marked `[now]`.
5. User selects a candidate version and clicks [Preview].
6. System fetches the version's content and displays it in the modal's preview area.
7. User clicks [Restore this version] or [Restore as copy].
8. For in-place restore: a confirmation dialog appears with exact file path, snapshot timestamp, and the warning "This cannot be undone."
9. User confirms. System writes the version content to the vault file, fires a vault `modify` event, and displays a success toast.
10. The restored version immediately enters the backup queue as the current live state.

**Business Rules:**
- A version list shows all retained versions across all tiers (recent, hourly, daily, weekly, monthly) merged into a single chronological list.
- Tier tags displayed alongside timestamps help the user understand why a version is retained (e.g., `[weekly]`, `[daily]`, `[14-day never-prune]`).
- Renamed files: versions under prior paths appear in the same list with a visual marker showing the prior path and rename date. This requires rename history to be represented in the backup data model (see SDD).
- Restore in place overwrites the vault file atomically (write to temp file in the same directory, then rename). Partial writes must not leave the file in a half-written state.
- The restored file's SHA-256 hash must match the hash recorded in the snapshot manifest; a mismatch after restore is a critical error surfaced to the user with "Restore integrity check failed — please retry."
- If the vault file was open in a modified-but-unsaved state, Obsidian is prompted to reload the file from disk after the restore completes.
- File history for the current file is computed on-demand; no persistent index of "all versions of all files" is maintained — each lookup walks the snapshot manifests.

**Edge Cases:**
- **File has never changed (1 version):** Modal shows the single entry with a message "Only one version on record — this file has not changed since it was first backed up." User can still preview or copy content.
- **File has 500+ versions (power user, low retention):** Modal loads the 50 most recent by default with a [Show 50 more] button. Infinite scroll is not used to keep memory bounded.
- **File was renamed mid-history:** Versions under prior paths are included; visual marker reads "Renamed from `Projects/old-name.md` on Apr 10".
- **File does not exist in current vault (was deleted) but history exists:** Command is invoked on a different open file, but the user wants to recover the deleted one — this case is handled by the Backup Browser (Feature 4), not this modal. The current command is strictly about the currently-open file.
- **Network is offline:** Modal opens; version list loads from last-known snapshot index (cached); previews and restores fail with a clear "Offline — versions known but content unreachable" notice.
- **Plugin is running on a passive (non-backup-owner) device:** Restore still works. The restored file enters the normal vault-event flow; the backup-owner device picks it up in its next backup cycle.

## Success Metrics

### Key Performance Indicators

Archivist is a single-maintainer, single-user-calibrated plugin at V1. Traditional SaaS KPIs (DAU, MAU, conversion rate) do not apply. Success is measured by qualitative reliability and by a small set of quantitative reliability targets.

- **Adoption (V1 baseline):** At least 100 installs from the Obsidian Community Plugin directory within 90 days of public release. This is a proxy for "the plugin is discoverable and clearly positioned against the unmaintained incumbent."
- **Engagement:** Backup-cycle success rate ≥ 95% over a 30-day window, measured via direct bug reports + the plugin's own issue tracker (no telemetry in V1 — see Tracking Requirements).
- **Quality — Reliability:** Zero reports of data-loss-on-restore (restored content ≠ recorded hash) in the first 180 days. Any such report is a P0 bug that blocks the next release.
- **Quality — Storage:** The reference vault (10k files, 2 GB, ~5 edits/day) stays under 100 GB total Dropbox usage for Archivist data across a 4-week test period with default settings. Formula: `ceiling ≤ vault_size × max_retained_snapshot_count` with `max_retained_snapshot_count` derived from default retention tiers.
- **Business Impact (indirect):** A community convergence signal — within 12 months, Archivist becomes the recommended answer in Obsidian forum posts, Reddit threads, and Discord channels when a user asks "how do I back up my vault to Dropbox."

### Tracking Requirements

**V1: No telemetry.** Decision recorded in spec Decisions Log. Success is measured via explicit user bug reports + the plugin's own issue tracker. No events emitted. No network calls other than Dropbox API.

If telemetry is ever added (post-V1), the event schema below is a **reference**, not an implementation commitment — any activation requires an opt-in user toggle, a documented privacy policy, and a new ADR.

<details>
<summary>V2 Reference Schema (NOT implemented in V1)</summary>

| Event | Properties | Purpose |
|-------|------------|---------|
| `plugin_loaded` | plugin_version, obsidian_version, platform (desktop/mobile), vault_size_bucket | Baseline install-and-active count |
| `backup_completed` | type (full/inc), duration_ms, file_count, size_bytes, device_id_hash | Reliability signal; backup-cycle success rate |
| `backup_failed` | type (full/inc), failure_category (network/auth/quota/other), retry_count | Failure classification; drives reliability work |
| `restore_initiated` | source (command-palette / backup-browser), file_type (text/binary), age_of_version_hours | Primary-use-case validation |
| `restore_completed` | duration_ms, success (bool), integrity_check_passed (bool) | Data-loss-on-restore P0 tracking |
| `retention_pass_completed` | snapshots_pruned_count, content_blobs_gc_deleted_count, final_storage_mb | Storage-ceiling validation |
| `first_run_completed` | oauth_completed_seconds_after_enable, predecessor_plugin_detected (bool) | Onboarding-friction measurement |

If adopted: no file paths, no file contents, no vault names, no user identifiers (device_id hashed client-side with a random salt generated once per vault install).

</details>

---

## Constraints and Assumptions

### Constraints

- **Technical — Obsidian platform.** The plugin runs inside Obsidian's Electron shell on desktop and its Capacitor shell on mobile. Long-running background tasks are not reliable on mobile (OS suspension). Platform API surface is `minAppVersion: 1.5` or higher.
- **Technical — Dropbox API scope model.** Restore requires `files.content.read`, and the plugin must be transparent about this in its README and settings copy. There is no narrower scope that supports file-level restore.
- **Technical — Deduplication vs. encryption.** Client-side encryption and content-addressed deduplication are architecturally incompatible in their naive forms. V1 chooses dedup; V2 may revisit.
- **Compliance — Obsidian Community Plugin Review.** The plugin must pass the Obsidian community-plugin review process. No `eval`, no `innerHTML` of user content, no undeclared external network calls.
- **Resource — Single maintainer.** One author (Marcus), part-time. This constrains scope aggressively — the Won't-Have list is large by design.
- **Resource — Timeline.** V1 is targeted for initial public release within 8–12 weeks of spec completion. Scope is calibrated to that budget, not to a fixed feature list.
- **Budget — Storage.** Reference user has a 2 TB Dropbox plan. Design target: Archivist uses ≤ 5% of plan under default retention for the reference vault.

### Assumptions

- **User assumption — vault size.** Target vault is ≤ 20k files and ≤ 5 GB. Beyond this, reconcile-scan and manifest-merge performance is untested. Larger vaults are supported in the sense of "will probably work," not "is tested and guaranteed."
- **User assumption — edit rate.** Target is ≤ 50 edits/day per device. Higher edit rates generate denser incremental manifests, which stresses the retention and GC passes — not currently measured.
- **User assumption — desktop-first.** The primary backup device is a desktop computer that is online most days. Mobile-only users are unsupported in V1 (no scheduling on mobile).
- **User assumption — technical literacy.** Users are comfortable with OAuth flows, settings pages with retention tiers, and reading a README. Archivist does not try to be a zero-config product.
- **Market assumption — incumbent is stale.** The predecessor plugin is publicly unmaintained (last commit 2024-06) and has GitHub issues describing the storage-fill-up problem that go unanswered. Users are actively searching for an alternative.
- **Dependency assumption — Dropbox SDK stability.** The `dropbox` npm package is still functional despite infrequent releases. A pinned version will remain installable and the underlying API will not break V1 endpoints.
- **Dependency assumption — Obsidian API stability.** `vault.on(...)` events, `TFile.stat`, `ItemView`, `Modal`, `MarkdownRenderer` all remain stable through the V1 release window.

## Risks and Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Restore integrity bug causes data loss (restored content ≠ recorded hash) | High | Medium | SHA-256 integrity check after every restore; failed check blocks success; regression tests cover randomized-content restore fidelity. |
| Storage ceiling exceeded in production due to retention bug | High | Medium | 4-week production-like soak test before release; storage warning at 80% of configured hard-limit; hard-limit defaults to 200 GB. |
| OAuth code-verifier state leak (predecessor's bug) | Medium | Medium | Code-verifier stored per-state in a bounded Map with TTL; not as module-level `let`; audited in code review. |
| Obsidian plugin review rejection | Medium | Medium | Pre-submission checklist: no `innerHTML` on user content, no `eval`, declared network domains, `minAppVersion` pinned; dry-run against known rejection reasons. |
| Dropbox API changes break V1 | Medium | Low | SDK pinned to exact version; lockfile committed; CI runs a weekly smoke test against a real Dropbox test account. |
| Multi-device race condition produces conflicting snapshots | High | Low | Explicit conflict detection on startup (see Feature 5 AC); refuses to upload on detected conflict; documented manual-takeover procedure. |
| User loses access token, Dropbox usage data orphaned | Low | Medium | Disconnect flow does NOT delete Dropbox data by default; user can reconnect and pick up history. Documented recovery procedure in README. |
| Reconcile scan blocks Obsidian UI on first run with large vault | Medium | High | First-run reconcile yields to event loop every N files; progress notice shown; documented 20k-file soft cap. |
| Dropbox desktop app double-syncs the Archivist folder to disk | Low | High | README warning + settings notice recommending selective-sync exclusion of `Apps/Archivist/` in the Dropbox desktop client. |
| Predecessor plugin (`obsidian-dropbox-backups`) runs concurrently and conflicts | Medium | Medium | First-run notice detects the old plugin and warns (Feature 8); cannot technically prevent simultaneous use, but the warning is the contract. |
| Token stored plaintext in `data.json` is leaked via support-bundle share | Medium | Low | README discloses plaintext storage; file permissions tightened (chmod 600); one-time notice if `data.json` appears to be under a cloud-sync path. |
| Obsidian Sync syncs `data.json` across devices, duplicating tokens | Medium | Low | Plugin detects and advises user against sync'ing plugin data folder for Archivist. |

## Open Questions

- [x] Resolved: Migration from `obsidian-dropbox-backups` → no automatic migration; V1 detects old plugin and warns (Feature 8 + W10).
- [x] Resolved: Localization → English-only V1 with centralized strings (W9).
- [x] Resolved: Client-side encryption → deferred to V2 (W8).
- [x] Resolved: Mobile scope → read-only Browse + Restore + manual backup trigger; no scheduling (S2, S4).
- [x] Resolved: Telemetry → **no telemetry in V1**. V2 reference schema retained in Tracking Requirements for future reference.
- [x] Resolved: Storage hard-limit default → **200 GB default**, user-configurable 10 GB – unlimited via Settings → Retention.
- [x] Resolved: Diagnostic logging → **two-level logger** (default + verbose), toggled by `advanced.diagnostic_logging`. Default level: plugin load/unload, Dropbox connection events, backup-start/end, errors-as-errors (no paths, no hashes, no content). Verbose level: adds per-file paths, raw SDK response metadata, queue-cursor movement. See SDD §Logging.
- [x] Resolved: License → **MIT**. Matches Obsidian community-plugin norm; predecessor uses MIT; no reason to pick otherwise (Apache-2.0 patent grant is over-engineered for a solo plugin; GPL would restrict forks unnecessarily).
- [x] Resolved: Plugin ID — `obsidian-archivist` confirmed free in the `obsidianmd/obsidian-releases` community-plugins registry as of 2026-04-23.

## V1 Prerequisites (not-yet-done, required before Phase 1)

- [ ] **Dropbox app registration** (owner: Marcus). Register a new Dropbox app in "App folder" mode at https://www.dropbox.com/developers/apps/create. Capture the `CLIENT_ID` and list the OAuth redirect URI as `obsidian://archivist-oauth` under "OAuth 2 → Redirect URIs". Feed `CLIENT_ID` into `src/infra/DropboxClient.ts` as a compile-time constant. **Blocks Phase 3 T3.3 (OAuth flow).** Do not reuse the predecessor plugin's `CLIENT_ID`.

---

## Supporting Research

### Competitive Analysis

- **`obsidian-dropbox-backups` (Aut-O-Backups).** Unmaintained since 2024-06. Full-backup every 20 min, no retention, no restore UI, no config. Reference for "what Archivist must beat."
- **Obsidian Sync.** Official, paid. 1-year version history per file. Recovery UX is a right-click menu "View version history" in the file, modal-style. Good UX; limited to Obsidian Sync subscribers; single-provider dependency (Obsidian holds both live and backup). Archivist complements rather than replaces — a belt-and-suspenders setup with Obsidian Sync (live) + Archivist (offsite versioned backup) is the intended combination for the serious-user persona.
- **Obsidian Git plugin.** Git-based backup to any Git remote. Excellent for text-only vaults; breaks down on binaries and large vaults (git repo size growth). Requires user to understand Git. Archivist targets the "I don't want to know what a rebase is" user.
- **Remotely Save plugin.** Supports multiple backends (WebDAV, S3, Dropbox, OneDrive). Sync tool rather than a backup tool — maintains a single replica, not versioned history. Archivist is versioned-history-first.
- **Rsync / custom scripts.** Power-user DIY. Archivist targets users who explicitly don't want to write cron scripts.

Key differentiator vs. all: **file-level in-app restore with a 3-click promise**. No other plugin ships this today.

### User Research

- **Reference user (Marcus).** Owner of the project; has used `obsidian-dropbox-backups` through the storage-fill-up failure mode. Primary design input. Vault size 10k files, ~2 GB, ~5 edits/day, 2 TB Dropbox plan.
- **Community signal — Obsidian forum / Reddit.** Unresolved GitHub issues on `obsidian-dropbox-backups` describing storage fill-up date back to 2023. Forum posts recommending it still appear, indicating discoverability of the problem is low and users adopt it, hit the wall, and churn silently. Exact user counts are not tracked.
- **Persona calibration.** Design is calibrated against the reference vault profile (§3 of source brainstorm). Non-goals explicitly flag that large-vault / high-edit-rate profiles are not validated for V1.

### Market Data

- Obsidian has ~1M+ users (self-reported, Obsidian team public statements). The Community Plugin directory shows `obsidian-dropbox-backups` at tens of thousands of installs (exact number shifts; broadly the plugin has market presence despite being unmaintained).
- Dropbox market: ~700M+ registered users; mature API; stable PKCE OAuth. The 2 TB Plus plan is a common tier for knowledge workers.
- The Obsidian plugin ecosystem rewards single-purpose, reliable plugins. Archivist's scope (backup + restore, Dropbox only) fits that pattern.
