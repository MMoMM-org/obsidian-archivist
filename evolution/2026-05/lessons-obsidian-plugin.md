# Lessons Learned — Obsidian-Plugin-Entwicklung Archivist

> Datum: 2026-05-05
> Bogen: PRD/ADR-Phase + Scaffolding (2026-04-23) → v0.7.4 + Post-V1-Hardening (2026-05-05)
> Stand: 257 Commits, 1050+ Tests, 0 ESLint-Errors, 0 deaktivierte `obsidianmd/*`-Regeln, 12 PRs Post-V1-Hardening, 37 Review-Findings → 0.

## 1. Was am Anfang stand vs. was rauskam

**Anfang (23.04.2026):**
- 20 ADRs, PRD + SDD + 12-Phasen-PLAN, 6 offene Fragen geschlossen, ~70 TDD-Tasks.
- Annahme: "wenn die Spec dicht ist, ist die Implementation Mechanik."
- Plugin-Architektur als saubere Schichten (Domain → Infra → Services → UI), Dropbox + OAuth + CAS-Storage konzeptionell durchdacht.
- Mentaler Stand: "wir haben Obsidian schon ein paar Mal gebaut" (Kado, Hashi-Charter) → Plugin-API ist bekannt.

**Ergebnis (05.05.2026):**
- Alle 10 Phasen ausgeliefert, Plugin lauffähig gegen echtes Dropbox, Backup-Browser + Restore-Pfade vollständig.
- Dutzende Bugs, die in der Spec **nicht** vorkamen, weil sie an der API-Realität, nicht an der Geschäftslogik hingen.
- Der Bogen: Spec war ~80% korrekt; die fehlenden 20% waren fast alle Obsidian-/Dropbox-API-Eigenheiten, die nur am echten Vault sichtbar werden.

## 2. Obsidian-API — die teuren Lektionen

Diese Sachen stehen in keinem ADR und in keinem Tutorial — sie wurden alle durch Real-World-Fehler gelernt:

- **`vault.modify` ≠ `adapter.writeBinary` + `adapter.rename`.** Auf getrackte TFiles muss über die High-Level-Vault-API geschrieben werden. Adapter-Layer scheint zu funktionieren (kein Fehler), aber der Editor-Cache und die Datei auf Disk laufen auseinander → Restore-Bug, sah aus, als wäre nichts passiert. Commit `e1377cb`.
- **`workspace.on('layout-ready', cb)` feuert nicht**, wenn das Plugin **nach** dem Layout enabled wird. Immer `app.workspace.onLayoutReady(cb)` (Helper feuert sofort, wenn schon ready). Ein Plugin, das via Settings deaktiviert + reaktiviert wird, hängt sonst stumm im LOADING-State. Commit `1143a04`.
- **`workspace.getLeaf(false)` allokiert immer einen neuen Leaf** — `false` steuert nur den Split, nicht Identity-Reuse. Ohne `getLeavesOfType` + `revealLeaf` stapelt jeder Ribbon-Klick einen neuen Tab. Commit `931050e`.
- **`workspace.on('file-menu')` deckt File-Explorer-Rechtsklick UND Note-3-Punkte-Menü ab** — nicht zwei Wirings nötig. Einer der teuersten "ich hab das falsche Event genommen"-Course-Corrections. Commit `af4edca`.
- **`addClass` / `removeClass`, niemals `el.className = ...`** auf Obsidian-managed DOM (Ribbon, Status-Bar, Setting-Items). Obsidian schreibt dort layoutkritische Klassen rein; Überschreiben bricht stumm das Styling. Commit `6e583e1`.
- **Popout-Windows sind real.** `document.activeElement` ist falsch — `activeDocument.activeElement` ist die fenster-skopierte Variante. Die `obsidianmd/prefer-active-doc`-Regel hat das ein Dutzend Mal vor Bugs geschützt; deshalb wurde sie auch nie ausgeschaltet.
- **`TextComponent.onChange` feuert auf `change`, nicht `input`** → bei Tab-Wechsel mitten im Tippen geht der letzte Wert verloren. Lösung: zusätzlich `input`-Listener auf `text.inputEl`. Commit `ef1156a`.

## 3. Persistence & In-Memory-State

Die schmerzhafteste Kategorie, weil die Symptome immer "alles sieht ok aus, aber X passiert/passiert nicht":

- **Closure auf `settings` snapshottet das Initial-Objekt.** Ein per UI verändertes Setting propagiert nie, weil der Closure noch auf dem alten Objekt sitzt. Lösung: mutable Container (`cachedRef.settings`), den die Update-Pfade neu zuweisen. Commit `9fe02c5`.
- **In-Memory-Wrapper muss alle Writes besitzen.** Wenn `BackupService` direkt über `pluginStore.saveQueue(...)` schrieb, war Disk korrekt, aber `EventQueue.entries` blieb stale → Phantom-No-Op-Backup alle 15 Minuten. Regel: Wrapper-Klasse als Dependency injecten, nie den darunterliegenden Store. Commit `461f8d6`.
- **Async-Felder in `SettingsContext` müssen vor dem ersten `display()` befüllt sein** — sonst rebuildet die Settings-Tab mid-typing und löscht den User-Input. Commits `0c12afd` / `b229281`.
- **`Date.now()` kollidiert auf ms-Granularität** in Schleifen über mehrere Files. Batch-Operationen brauchen einen geteilten Timestamp pro Batch — sonst überschreibt File N silent File N-1 ("50 restored", auf Disk steht 1). Commit `1847b86`.
- **`bytes.buffer` exposed das ganze Backing-ArrayBuffer**, nicht nur die aktive Range. Bei `subarray()`-Resultaten in `writeBinary` schreibt man zigfache Datenmenge auf Disk. Immer in einen exakt dimensionierten Buffer kopieren.

## 4. Externe APIs — Dropbox

- **Pfad-Konvention 1: App-Folder-Scope prefixt server-seitig automatisch `/Apps/Archivist/`.** Client-Code darf den Namen NICHT mitschicken — sonst landen Dateien in `/Apps/Archivist/Apps/Archivist/...`. Die Tests waren grün, weil die Mocks den Pfad nicht inspizierten — Production lieferte 1050 Tests grün und Daten an die falsche Stelle. Commit `41e8461`.
- **Pfad-Konvention 2: Alle `files/*`-Pfade müssen mit `/` beginnen.** Das JS SDK fügt das nicht hinzu. Normalisierung an der SDK-Boundary in `DropboxClient.normalizeApiPath`. Commit `109572e`.
- **`/2/users/get_current_account` lehnt `application/x-www-form-urlencoded` ab.** Der OAuth-Helper, der für `/oauth2/token` form-urlencoded sendet, ist NICHT für `/2/...`-Endpoints wiederverwendbar.
- **Lehre fürs Mocking:** Mocks, die nur die Form, aber nicht den Inhalt prüfen (z. B. `arg.path`), maskieren ganze Bug-Klassen. Mock-Schreibung muss Production-Invarianten erzwingen.

## 5. Tests, Mocks, Fixtures

- **Tests sind nicht Teil von `tsc`** (`rootDir: "./src"`). Diagnostics in `tests/**/*.ts` sind Build-Lärm — nicht "fixen", den Vitest-Runtime juckt's nicht.
- **`tests/fixtures/obsidian-mock.ts` ist die einzige `obsidian`-Resolution.** Jedes neue `import { X } from 'obsidian'` in `src/` braucht einen Stub im Mock — sonst feuert der nächste Test mit `X is not a constructor`.
- **MockEl-Helper müssen `opts` verbatim weiterleiten.** Ein `createDiv`, das nur `cls` durchreicht, ist ein latenter Bug: das nächste Lint-`--fix` (z. B. `prefer-create-el`) migriert Production zu `createDiv({ attr: ... })` und Tests fallen über. Commit `1e6b9a8`.
- **Modal-öffnender Code muss in Tests gemockt werden.** `new Modal().open()` greift in `onOpen()` auf `activeDocument.activeElement` — existiert in Vitest nicht. Pattern: Stub-Klasse mit `static _last`-Recording.
- **Fixture-Composability ≠ produktiv möglicher State.** Tests, die `(fresh remote, populated local index)` konstruieren konnten, haben eine Production-Invariante verletzt — und das blieb invisible bis ein Probe-Code dazukam. Fixture muss die Invariante per Default erzwingen. Commit `0625e13`.

## 6. UI/UX — invisible Failures

- **Silent Validate ist nicht "Save kaputt", sieht aber genauso aus.** 4-Commit-Jagd nach "vault_prefix speichert nicht" — User hatte Großbuchstaben getippt, Regex hatte abgelehnt, kein UI-Feedback. Regel: jede Validate-on-Input muss ihren Fehler dem User zeigen, niemals stumm schlucken. Commit `70ee73a`.
- **`aria-live` für dynamische Status-Regionen** (Recovery-Banner, Filter-Result-Counts) — nicht optional für Screen-Reader-Nutzer.
- **Fokus-Outline `outline: none` mit nur Border-Color-Wechsel** ist a11y-broken. `outline: 2px solid var(--interactive-accent); outline-offset: 2px;` ist die Konvention im Repo.
- **`vault.modify` aus dem Plugin feuert dasselbe `modify`-Event wie User-Edits.** ChangeDetector kann nicht unterscheiden — Restore triggerte direkt das nächste Inc-Backup. Lösung: am Sink absorbieren (Inc-Window basiert auf `earliest_pending_observed_at`), nicht am Source unterdrücken. Commits `17453bb` / `8565463`.

## 7. Prozess- und Workflow-Lehren

- **XDD → validate → review als kompletter Bogen war richtig**, auch wenn es sich vor dem ersten Commit verschwenderisch anfühlte. Die ADR-Phase hat ~10 Bug-Kategorien antizipiert, die sonst Wochen gekostet hätten (CAS-Dedup-Layout, Chain-Topologie, OAuth-Disconnect-Reihenfolge).
- **Per-ADR-Approval für load-bearing, Batch für Rest.** Decision-Capital ist endlich; nicht jede Implementations-Detail-ADR braucht eine Diskussion.
- **YAGNI-Cuts nach Reviewer-Konsens akzeptieren** und Re-Add-Pfad dokumentieren — nicht "for completeness" stehen lassen.
- **Instrument before theorize.** Bei Persistence/Save-Bugs **erst** Diag-Logs an Chain-Ein-/Ausgang, **dann** Hypothesen. User-Pushback ("vault_prefix speichert immer noch nicht") ist Disproof, nicht Diskussion.
- **Probe the data you're about to USE, nicht ihr Sentinel.** PR #9 probte `HEAD.json` für Korruptionserkennung; der reale Fehler war ein gebrochenes Glied weiter unten in der Chain. PR #11 probt jetzt das Parent-Manifest selbst. Commit `024f277`.
- **"Probe-then-recover" muss drei Buckets haben**, nicht zwei: (a) Absence → recover, (b) transient → re-throw, (c) permanent → re-throw. (b)+(c) zu "swallow everything else" zu kollabieren, versteckt echte Fehler.

## 8. Was sich gegen die Erwartung änderte

- **Domain-Logik war fast bug-frei**, weil sie testbar war (Hexagonal: `ManifestBuilder`, `RestoreService.materializeVaultStateAt` sind reine Funktionen mit Walkthrough-aus-SDD).
- **UI- und API-Boundary-Code war 80% der Bugs**, obwohl er ~30% des LOC ausmacht. Hier braucht es Real-Vault-Manual-Testing — Unit-Tests reichen nicht.
- **Der `obsidianmd`-Lint-Plugin hat sich völlig gelohnt.** Er fing zwischen Phase 7 und 9 mehrere Bug-Klassen, die sonst erst beim User aufgefallen wären (popout-window-Globals, manage-class, `prefer-active-window-timers`).
- **Hot-Reload-Vault unter `test/Archivist/`** war die wichtigste Single-Improvement der DX. Disable/Enable-Cycle vs. echter Restart ist ein 30x-Faktor in Iteration-Speed.

## 9. Wenn ich heute nochmal von vorn anfangen würde

1. **Manuelle First-Light-Session viel früher** — nach Phase 5, nicht nach Phase 9. Zwei Wochen Path-Prefix-, Content-Type-, `vault.modify`-Bugs wären in einem Tag gefunden worden.
2. **Mock-Audit als Phase-Abschluss-Gate** — nach jedem Feature: "welche neuen `obsidian`-Imports? Welche neuen DOM-Methods? Spiegel im Mock?".
3. **`scripts/dropbox-inspect.mjs` von Tag 1** — nicht erst beim ersten 400er. Raw-HTTP-Diagnose-Tools sind keine "wenn-mal-Zeit-ist"-Sachen.
4. **Closure-vs-Snapshot als Code-Review-Checkliste:** jede Funktion, die ein Setting "live" liest, muss durch einen mutable Container gehen — sonst snapshottet sie.
5. **Probe-Pattern als ADR**, nicht als gelernter Reflex.
