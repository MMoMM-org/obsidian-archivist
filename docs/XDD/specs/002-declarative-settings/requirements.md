---
title: "Searchable settings — migrate Archivist's settings tab to Obsidian's declarative settings"
status: approved
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
Every Archivist setting can be found from Obsidian's global settings search, so users reach the option they need in one step instead of scrolling through a long settings tab.

### Problem Statement
Since Obsidian 1.13.0, the settings window has a global search that finds individual settings across all tabs. It only finds settings that a plugin declares in Obsidian's new declarative settings format. Archivist still builds its tab the old way, so **none of its 30+ settings (Schedule, Retention, Notifications, Advanced, Dropbox account) appear in search**.

Evidence:
- Obsidian's automated plugin review flags this on Archivist's community scorecard (community.obsidian.md, scan of 2026-09-01, release 0.11.7): *"This PluginSettingTab does not implement getSettingDefinitions(); its settings will not appear in Obsidian's settings search for users on 1.13.0 or later."* It is the only open warning on the scorecard.
- GitHub issue #54 named "the review bot starts flagging" as the trigger for doing this migration. That trigger has now fired.
- The old building style is officially deprecated as of Obsidian 1.13.0. Its button styling (`setWarning`) and slider tooltip (`setDynamicTooltip`) are deprecated too.

Consequences of not solving it:
- Users who search for "retention", "Dropbox" or "backup time" get no Archivist results and may conclude the option doesn't exist.
- The scorecard warning stays visible to anyone evaluating the plugin.
- Every future Obsidian release widens the gap with deprecated APIs.

### Value Proposition
- **For users:** settings are reachable by typing their name, just like Obsidian's core settings and the plugins that have already migrated. Nothing else changes: same sections, same options, same behaviour.
- **For the maintainer:** the plugin is back to a clean scorecard and on Obsidian's supported settings path. This also becomes the reference migration for the other MiYo plugins (Kado, Hashi, Hakobi).

## User Personas

### Primary Persona: Current-Obsidian Archivist user
- **Demographics:** Obsidian user of any age who backs up a personal knowledge vault to Dropbox. Moderate technical comfort: configures plugins through the settings UI, never edits `data.json` by hand. Runs Obsidian 1.14.4 or newer on desktop.
- **Goals:** Find and change a specific backup option quickly (for example the full-backup time, retention days or diagnostic logging) and trust that the change took effect.
- **Pain Points:** Archivist's tab is long, with five sections and about 30 rows. Global settings search returns nothing for Archivist, so they have to open the tab and scroll. They can't tell whether a setting exists without reading the whole tab.

### Secondary Personas

**Outdated-Obsidian Archivist user**
- **Demographics:** Same profile, but stays on an Obsidian version below 1.14.4. Possible reasons: a managed device, a deliberate update freeze, or not having updated yet.
- **Goals:** Keep backing up without disruption.
- **Pain Points:** Would be harmed if an update broke the settings tab or backups. Needs to keep a working release even though new Archivist releases will require 1.14.4.

**Plugin maintainer**
- **Demographics:** The sole maintainer of Archivist (and of the sibling MiYo plugins). Expert TypeScript and Obsidian API user.
- **Goals:** A clean community scorecard, no deprecated APIs, lint clean against current Obsidian types, and one settings model that can't drift.
- **Pain Points:** A scorecard warning they can't dismiss. A types dependency pinned at 1.12.3 that blocks routine Dependabot bumps. The prospect of repeating this migration in three more plugins without a reference.

## User Journey Maps

### Primary User Journey: Find a setting by search
1. **Awareness:** The user wants to change something about their backups (for example "make backups stop at night") and doesn't remember where the option is.
2. **Consideration:** They can scroll through Archivist's tab or type into the global settings search. Search is faster if it returns results.
3. **Adoption:** They type "backup window" into the settings search and Archivist's "Active backup window" row appears among the results.
4. **Usage:** They pick the result, land on Archivist's settings tab at that setting, change it, and the change saves exactly as it does today.
5. **Retention:** Next time they search again, because Archivist settings now behave like every other searchable setting.

### Secondary User Journeys

**A. Settings stay live while the tab is open** (Current-Obsidian user)
1. The user has Archivist's settings tab open.
2. Something changes in the background: a persistent warning appears or clears (for example "Dropbox authorization lost" or a quota warning), or the Dropbox connection finishes after the OAuth round-trip.
3. The tab reflects the new state without the user closing and reopening it.
4. Text the user is typing at that moment (for example the Dropbox vault folder) is not wiped by the refresh.

**B. Destructive action is recognisable** (Current-Obsidian user)
1. The user, connected to Dropbox, looks at the account row.
2. "Disconnect" is visibly styled as a destructive action, distinct from "Re-authenticate".
3. Behaviour on click is unchanged from today.

**C. Staying on an older Obsidian** (Outdated-Obsidian user)
1. A new Archivist release requires Obsidian 1.14.4.
2. Obsidian's plugin updater does not offer that release to them. They keep the last release that supports their Obsidian version, with their settings and backups intact.
3. When they update Obsidian to 1.14.4 or newer, the new Archivist release is offered and their existing settings carry over unchanged.

**D. Release verification** (Plugin maintainer)
1. The maintainer ships the release.
2. Obsidian's review re-scans it. The getSettingDefinitions warning is gone and no new warning or failure flag appears.
3. The maintainer uses this migration as the template for a handoff to Kado, Hashi and Hakobi.

## Feature Requirements

### Must Have Features

#### Feature 1: Every setting is findable through Obsidian's global settings search
- **User Story:** As a Current-Obsidian user, I want to find any Archivist setting by typing its name into the settings search so that I don't have to scroll through the tab.
- **Acceptance Criteria:**
  - [ ] Given Obsidian 1.14.4 or newer with Archivist enabled, When the user types the name of any user-editable Archivist setting (every row listed in "Settings inventory" below) into the settings search, Then that setting appears in the results attributed to Archivist
  - [ ] Given a search result for an Archivist setting, When the user selects it, Then Archivist's settings tab opens showing that setting
  - [ ] Given a setting that is currently hidden by a condition (for example "Active window start" while the active window is off), When the user searches for it, Then it does not appear in the results
  - [ ] Given the Dropbox account is not connected, When the user searches for "Dropbox", Then the account row (with "Connect Dropbox") is found; and Given it is connected, Then the account row (with "Re-authenticate" / "Disconnect") is found
  - [ ] Given purely informational text (the version header, the token-storage disclosure, the retention estimate), When the user searches for words that appear only in it, Then it is not required to appear in the results

#### Feature 2: Settings tab parity
- **User Story:** As any Archivist user on a supported Obsidian version, I want the settings tab to look and behave the same after the migration so that I don't have to relearn it or lose configuration.
- **Acceptance Criteria:**
  - [ ] Given the migrated tab, When it opens, Then it shows the same sections in the same order (Schedule, Retention, Notifications, Advanced, Dropbox account) with the same rows, labels, descriptions, options and bounds as release 0.11.x
  - [ ] Given the version/author/documentation header and the persistent banners shown today, When the tab opens, Then they are still shown at the top of the tab, before the sections
  - [ ] Given existing saved settings from a 0.11.x install, When the user upgrades and opens the tab, Then every control shows the previously saved value, and no setting is reset or renamed
  - [ ] Given the user changes any control, When the change is accepted, Then it saves under the same setting it saves to today, and takes effect with the same timing as today
  - [ ] Given invalid input in a field that validates today (HH:MM times, Dropbox vault folder), When the user enters it, Then it is rejected and an inline error is shown, as today
  - [ ] Given input that is silently ignored today (out-of-range numbers, invalid exclusion globs), When the user enters it, Then it is still not saved (whether an error is shown is out of scope, see Won't Have)
  - [ ] Given the "This device backs up the vault" toggle, When the user switches it, Then it triggers take-ownership / release-ownership exactly as today, and it is not saved as an ordinary setting value
  - [ ] Given the storage usage reaches the warn threshold, When the tab opens, Then the storage warning is shown in the Retention section as today; and Given usage is below the threshold or the hard limit is 0, Then it is not shown

#### Feature 3: Live refresh of state-dependent content
- **User Story:** As a Current-Obsidian user with the settings tab open, I want banners, account state and other state-dependent values to update on their own so that I always see the current state.
- **Acceptance Criteria:**
  - [ ] Given the tab is open, When a persistent banner is raised or cleared anywhere in the plugin, Then the tab shows or removes it without being reopened
  - [ ] Given the tab is open and the user completes the Dropbox OAuth flow (or disconnects), When the account state changes, Then the Dropbox section switches between its connected and disconnected versions without being reopened
  - [ ] Given account email, device designation or storage usage are fetched in the background, When the values arrive, Then the tab shows them; and Given a fetch fails, Then the last known value stays shown and no error is raised
  - [ ] Given the user is typing in a text field, When a background refresh happens, Then the text being typed is not lost or overwritten
  - [ ] Given the settings window is closed, When background state changes, Then no settings UI is rendered and the only work done is refreshing the settings-search index (no fetches, no saves)

#### Feature 4: Destructive action styling
- **User Story:** As a Current-Obsidian user, I want the Dropbox "Disconnect" button to be clearly marked as destructive so that I don't confuse it with "Re-authenticate".
- **Acceptance Criteria:**
  - [ ] Given a connected Dropbox account, When the account row is shown, Then "Disconnect" uses Obsidian's current destructive-button style and "Re-authenticate" stays neutral
  - [ ] Given a disconnected account, When the "Connect Dropbox" button is shown, Then it has neither destructive nor call-to-action styling, as today

#### Feature 5: Raise the supported Obsidian version to 1.14.4
- **User Story:** As an Outdated-Obsidian user, I want to keep a working Archivist when new releases require a newer Obsidian so that my backups are not disrupted; and as the maintainer, I want the declared minimum to match the Obsidian version the code is built for so that no unsupported API reaches users.
- **Acceptance Criteria:**
  - [ ] Given the release, When its metadata is read, Then the declared minimum Obsidian version is 1.14.4 and every existing release-history entry is unchanged (0.8.0–0.11.x still map to 1.11.4, older entries to 1.5.0)
  - [ ] Given a user on Obsidian below 1.14.4, When Obsidian checks for plugin updates, Then the new release is not offered and the installed release keeps working unchanged
  - [ ] Given the user documentation (installation, troubleshooting, README), When it is read after the release, Then it states 1.14.4 as the minimum Obsidian version, states that installs on older Obsidian stay on the last 0.11.x release and receive no further Archivist updates, and states that updating Obsidian to 1.14.4 or newer unlocks the new release
  - [ ] Given the changelog entry for the release, When it is read, Then it calls out the raised minimum version as a notable change

#### Feature 6: Review and lint compliance
- **User Story:** As the maintainer, I want the release to pass Obsidian's automated review and the repo's lint against current Obsidian types so that the scorecard is clean and future type bumps flow normally.
- **Acceptance Criteria:**
  - [ ] Given the release after Obsidian's next review scan, When the scorecard is checked, Then the "does not implement getSettingDefinitions()" warning is gone and there are no new warnings or failure flags in Source code, Build verification or Dependencies
  - [ ] Given the repo's lint configuration, which mirrors the review bot, When lint runs against Obsidian 1.14.4 types, Then it reports zero errors and no uses of deprecated settings or button APIs
  - [ ] Given the existing automated test suite, When it runs, Then all settings-related tests pass; any test changed for the new tab keeps asserting the same behaviour, and no test is deleted without a replacement that asserts the same behaviour
  - [ ] Given the "ignore minor bumps" rule for the Obsidian types dependency set up for issue #54, When the release is merged, Then the ignore is lifted (it lives on GitHub as an `@dependabot ignore` comment state, not in `.github/dependabot.yml`) by commenting `@dependabot unignore obsidian` on the next Dependabot group PR, so routine updates resume

### Should Have Features

#### Feature 7: Conditional rows react immediately
- **User Story:** As a Current-Obsidian user, I want rows that depend on another setting to appear or disappear as soon as I flip that setting so that I can configure them in one go.
- **Acceptance Criteria:**
  - [ ] Given "Active backup window" is off, When the user turns it on, Then "Active window start" and "Active window end" appear without reopening the tab
  - [ ] Given they are shown, When the user turns the toggle off, Then both rows disappear and drop out of search results

  _Note: today these rows only appear after the next full re-render. The declarative format gives this almost for free. It overlaps with one of the defects being filed as a separate issue, which should be closed by this spec if Feature 7 ships._

#### Feature 8: Search synonyms
- **User Story:** As a Current-Obsidian user, I want common alternative words to find Archivist settings (for example "cloud" → Dropbox account, "interval" → incremental backup interval, "exclude" / "ignore" → exclusion globs) so that I find the setting even when I don't know its exact label.
- **Acceptance Criteria:**
  - [ ] Given the synonym list below, When the user searches for a synonym, Then the matching Archivist setting appears in the results

  Synonym list (complete for this release):

  | Setting | Synonyms |
  |---|---|
  | Account (Dropbox account) | dropbox, cloud, connect, login |
  | Exclusion globs | exclude, ignore, skip |
  | Incremental backup interval | interval, frequency |
  | Full backup time (local) | schedule, time |
  | Full backup cadence | weekly, monthly |
  | Active backup window | quiet hours, night |
  | Daily retention (days) | prune, keep |
  | Hard storage limit (GB) | quota, space |
  | Dry-run mode (no uploads) | test, simulate |
  | Diagnostic logging (paths visible in logs) | debug, log |
  - [ ] Given a search for a word unrelated to any synonym or label, When the user searches, Then Archivist settings do not appear in the results

### Could Have Features
- **Settings-search smoke checklist in the docs:** a short manual verification list for maintainers, reusable for Kado, Hashi and Hakobi.
- **Cross-plugin handoff:** an `_outbox/` handoff to Kado, Hashi and Hakobi describing the migration pattern and its gotchas. Sending it is optional for this release; the other plugins' own migrations are out of scope.

### Won't Have (This Phase)
- Fixes for the existing settings-tab defects found during research. Each gets its own GitHub issue:
  - the Disconnect confirmation is a stub that always confirms;
  - change handlers spread a stale settings snapshot, so quick edits can overwrite each other;
  - out-of-range numbers and invalid globs are rejected without any error shown;
  - deviceId is never displayed, and the `readonly` / `button` field kinds are unused;
  - a hidden tab can re-subscribe to banner updates.
  The active-window re-render defect is covered by Feature 7 if it ships.
- A real confirmation dialog for Disconnect (Obsidian's new confirmation modal). This belongs to the stub-confirm issue.
- Moving the Dropbox token storage UI to Obsidian's new "secret" setting type.
- Restructuring the tab into sub-pages, renaming or regrouping settings, or new settings.
- Support for Obsidian below 1.14.4 in new releases, including any fallback rendering path.
- Migrating Kado, Hashi or Hakobi.
- Mobile support (Archivist stays desktop-only).

## Detailed Feature Specifications

### Feature: Live refresh of state-dependent content (Feature 3)
**Description:** Parts of the tab depend on state that changes outside the tab:
- persistent banners raised by backup, authentication and recovery flows;
- the Dropbox account connection;
- background-fetched values: account email, device designation and storage usage.

Today the whole tab is rebuilt whenever any of these change. In the migrated tab, these changes must still reach the open tab promptly. They must also keep the search results accurate (for example the Dropbox row must match the connected or disconnected state), and must never destroy what the user is typing.

**User Flow:**
1. User opens Archivist's settings tab.
2. System shows the current state: banners, account row, current values. It starts any background fetches it needs.
3. A background fetch completes, or a banner is raised or cleared, or the OAuth flow completes.
4. System updates the affected parts of the open tab.
5. User keeps editing. Any text field being typed in keeps its content and focus.

**Business Rules:**
- Rule 1: A banner raised while the tab is open appears within the same refresh cycle as today, without user action.
- Rule 2: Background-fetched values that fail keep their last known value. Failures are never surfaced as new errors in the tab.
- Rule 3: A refresh must never reset a text field the user is focused on.
- Rule 4: State changes while the settings window is closed must not cause visible UI work. They may refresh what the settings search knows about, so results match the current state the next time the user searches.
- Rule 5: Only one background refresh runs at a time. A refresh cannot trigger an endless chain of refreshes.

**Edge Cases:**
- Several banners change in quick succession → Expected: the tab settles on the final set without flicker loops or duplicated banners.
- OAuth completes while the user is typing in the Dropbox vault folder → Expected: the account row updates; the folder text is untouched.
- The tab is closed mid-refresh → Expected: no errors, and no lingering updates to a closed tab.
- Dropbox is unreachable (offline) → Expected: last known account email and usage stay shown; no new banner is raised by the settings tab itself.
- The user reopens the tab after state changed while it was closed → Expected: the tab shows the current state immediately.

## Success Metrics

### Key Performance Indicators

- **Adoption:** 100% of user-editable Archivist settings (the Settings inventory, about 30 rows) are findable by name through global settings search on Obsidian 1.14.4 or newer. Verified per release with the manual checklist.
- **Engagement:** Not measurable by design, because Archivist has no telemetry (MiYo Constitution, Privacy & Security L1). Proxy: no GitHub issue in the 30 days after release asking where a setting is.
- **Quality:**
  - zero regressions: all existing settings tests pass;
  - zero new settings-related bug reports within 30 days of release;
  - zero lint errors against 1.14.4 types.
- **Business Impact:** the community scorecard shows zero warnings in Source code after the next review scan (today: 1), and the Obsidian types dependency follows Dependabot again (today: blocked by the ignore rule).

### Tracking Requirements

Archivist collects no usage data, and none may be added. Every metric is tracked through maintainer-side sources:

| Event | Properties | Purpose |
|-------|------------|---------|
| Community review scan of the release | release version, warning / failure-flag counts per category | Business-impact KPI (scorecard clean), Feature 6 |
| Manual search smoke check per release | setting name, found yes/no, Obsidian version | Adoption KPI, Feature 1 |
| CI run on the release branch | test pass/fail counts, lint error count | Quality KPI, Features 2 and 6 |
| GitHub issues labelled settings within 30 days after release | count, type (bug / "can't find setting") | Quality and engagement-proxy KPIs |
| Dependabot PR for the Obsidian types after release | opened yes/no | Business-impact KPI (types follow upstream again) |

---

## Constraints and Assumptions

### Constraints
- Sole maintainer; no deadline, but the change must ship as one feature on its own branch and PR, separate from the defect fixes.
- The minimum supported Obsidian version becomes 1.14.4, matching the Obsidian types used to build. Decided on 2026-11-20 instead of keeping a dual-version path.
- Desktop only (`isDesktopOnly`).
- No telemetry and no new network calls (MiYo Constitution, Privacy & Security L1).
- The settings stay where they are stored today. Credentials stay out of the synced settings file (Constitution, Privacy & Security L2).
- The repo's lint mirrors Obsidian's review bot and must pass with zero errors (Constitution, Code Quality L2).
- The plugin's CSS browser-compatibility target is tied to the minimum Obsidian version. Raising the minimum may change which CSS features are allowed. The impact is to be checked, not assumed.

### Assumptions
- Most active Archivist users are on Obsidian 1.14.4 or newer, or will update soon. This is not measurable without telemetry; the risk is accepted. Users on older versions keep the last compatible release.
- Obsidian's plugin updater honours the release-history file and does not offer a release whose minimum version the installed Obsidian doesn't meet. This is standard Obsidian behaviour.
- Selecting a search result takes the user to Archivist's tab at that setting. The exact scroll/highlight behaviour belongs to Obsidian and is not under Archivist's control; 1.13.1 fixed navigation from search results.
- Obsidian's declarative settings format can express every row type Archivist shows today, using custom rows where no built-in control exists, such as button rows and banners. To be confirmed in the SDD.

## Risks and Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Users on Obsidian below 1.14.4 stop receiving fixes | Medium | Medium | Release history pins older Archivist releases to 1.11.4; docs and changelog explain it; critical fixes could be back-ported if a report comes in |
| A row type can't be expressed declaratively and becomes invisible to search | Medium | Low | Research shows custom rows are indexed by name and description; the SDD maps every row before implementation; Feature 1 acceptance checks every inventory row |
| A background refresh wipes text the user is typing (a regression of a past bug) | High | Medium | Feature 3 acceptance criterion; automated structural guard (every text-entry row is a native control row, which Obsidian keeps while focused) plus a manual check in real Obsidian, since the test mock cannot reproduce Obsidian's re-render |
| Behaviour drift: a setting saves to a different place or resets on upgrade | High | Low | Feature 2 acceptance on existing installs; settings stay stored where they are today |
| The review bot raises a new warning, for example a deprecated API or CSS compat after the minimum-version bump | Medium | Medium | Lint against 1.14.4 types and the CSS compat check before release; run `/obsidian-eval` after the scan |
| Obsidian's declarative API changes shape between versions (it did between 1.13.0 and 1.13.1) | Low | Low | The minimum version equals the types version, so the shapes we compile against are the ones users run |

## Open Questions

- [x] Keep supporting Obsidian below 1.13 through a fallback? → **No.** Raise the minimum to 1.14.4 (decided 2026-11-20).
- [x] Fix the existing settings-tab defects here? → **No.** Separate issues (decided 2026-11-20).
- [x] Should Feature 7 (conditional rows react immediately) and Feature 8 (search synonyms) ship in this release? → **Yes, both** (decided 2026-11-20 at PRD review).

---

## Supporting Research

### Competitive Analysis
Other Obsidian plugins have already migrated to declarative settings:
- obsidian-maps (minimum 1.13.1)
- Hider (1.13.1)
- Templater, Local REST API and Encrypt (1.13.x)
- Linter (1.14.4)

Most raised their minimum Obsidian version and dropped the old rendering. They use custom rows for anything that isn't a standard control, and trigger a refresh when external state changes. BRAT is the exception: it supports both old and new Obsidian, at the cost of keeping two implementations in sync and a local copy of the types. Archivist follows the majority approach.

### User Research
No direct user research; Archivist collects no usage data. Signals:
- Obsidian's automated review flags the missing declarative settings as the plugin's only open warning.
- Obsidian deprecated the third-party "Settings Search" plugin in 1.13.1 because global search is now built in, so users are expected to rely on it.

### Market Data
- Archivist is listed in the official community directory: about 2k downloads, 41 releases, latest 0.11.7.
- Obsidian 1.13.0 introduced declarative settings (2026-05-28); 1.14.4 is the current types release (2026-10-08).

### Settings inventory (for Feature 1 acceptance)
- **Schedule:**
  - This device backs up the vault
  - Full backup cadence
  - Full backup day
  - Full backup time (local)
  - Incremental backup interval
  - Startup grace period (minutes)
  - Quiet period after edits (minutes)
  - Active backup window
  - Active window start (conditional)
  - Active window end (conditional)
- **Retention:**
  - Always keep most-recent snapshots
  - Recent high-frequency window (hours)
  - Never-prune window (days)
  - Daily retention (days)
  - Monthly retention (years)
  - Hard storage limit (GB)
  - Warn at percent of cap
- **Notifications:**
  - Show pre-flight notice before full backups
  - Show toast after incremental backup
  - Show toast after full backup
  - Show toast on error
- **Advanced:**
  - Exclusion globs
  - Enable reconcile scan on startup
  - Dry-run mode (no uploads)
  - Diagnostic logging (paths visible in logs)
  - Dropbox vault folder
  - Concurrent uploads
  - Upload chunk size (MB)
- **Dropbox account:**
  - Account (Connect / Re-authenticate / Disconnect)
  - How tokens are stored (documentation link)
