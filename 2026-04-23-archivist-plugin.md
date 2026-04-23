# Archivist — Obsidian Plugin Spec

**Tagline:** „Your vault's quiet historian."

**Status:** Brainstorm-Output, bereit für `/xdd` (PRD + SDD).
**Author:** Marcus Breiden
**Date:** 2026-04-23
**Target:** Obsidian Community Plugin, Desktop-first, Dropbox als Storage-Backend
**Plugin ID (proposed):** `obsidian-archivist`

---

## 1. Problem & Motivation

Der Vorgänger (`obsidian-dropbox-backups` / „Aut-O-Backups") hat drei strukturelle Schwächen, die bei realer Nutzung Schmerzen verursachen:

1. **Full-Backup alle 20 Minuten ohne Retention** — der Dropbox-Account läuft zwangsläufig voll. Bei einem 2 GB-Vault werden täglich ~144 GB Dopplungen abgelegt.
2. **Keine Konfigurationsmöglichkeit für Intervalle oder Retention.**
3. **Kein Restore-Pfad im Plugin.** Der User muss Dropbox-Web öffnen und manuell ausmisten, um zu wissen, welche Version die richtige ist („wann war die letzte Änderung vor dem Fehler?").

Zusätzlich: veraltete Dependencies, vendored Dropbox-SDK (105 KB im Repo), keine Tests, ungefangene async-Fehler, letzte Aktivität 2024-06. Rewrite ist günstiger als Refactor.

## 2. Goals & Non-Goals

### V1 Goals

- Automatische, inkrementelle Backups nach Zeitplan mit Quiet-Period-Schutz.
- Hierarchische Retention mit automatischem Cleanup — Dropbox läuft *nicht* voll.
- Restore einzelner Dateien inkl. Preview und History — „welche Version war korrekt?" in ≤ 3 Klicks.
- Multi-Device-sicher: genau ein Gerät ist Backup-Owner, andere passiv.
- Robust gegen externe Sync-Tools (iCloud, Syncthing, Git, Dropbox-Desktop-App).

### Non-Goals V1

- Full-Vault-Restore mit Wipe+Replace (Disaster Recovery).
- Alternative Cloud-Backends (S3, Google Drive).
- Mobile-Backup-Scheduling.
- Timeline-Visualisierung der Historie.
- Full-Text-Search über Snapshots.
- Automatische Komprimierung der Content-Blobs (Dropbox speichert ohnehin binär).

## 3. Vault-Profil (Referenz-User)

Design-Kalibrierung basiert auf:

- Vault: 10k+ Files, ~2 GB, überwiegend Markdown/Text, wenig Binaries
- Dropbox: 2 TB-Plan (Storage ist nicht der Engpass → Retention dient der **Übersichtlichkeit**, nicht der Speicher-Einsparung)
- Änderungen: ~5 Files pro Tag (niedrige Write-Frequenz)
- Devices: 2+ (Desktop primär, Mobile sekundär read-only)

Defaults werden auf dieses Profil optimiert, aber **alle Werte sind konfigurierbar**.

## 4. Architecture

### 4.1 Storage Layer — Content-Addressed Storage (CAS)

Zwei getrennte Layer im Dropbox-App-Folder:

```
/Apps/Archivist/<VAULT>/
├── content/                       ← Bag aller jemals gesehenen File-Contents
│   ├── ab/abcd1234...sha256        ← Pfad-Prefix = erste 2 Hex-Zeichen, Name = voller SHA-256
│   └── ef/ef567890...sha256
└── snapshots/
    ├── 2026-04-01T03-00-full.json  ← Manifest: {paths → content-hashes}
    ├── 2026-04-01T10-00-inc.json
    └── 2026-04-01T11-00-inc.json
```

- **Content-Layer**: jede einzigartige File-Version einmal abgelegt, Name = SHA-256 des Contents. Dedup ist dadurch automatisch (gleicher Inhalt → gleicher Hash → einmal hochgeladen).
- **Snapshot-Layer**: kleines JSON-Manifest pro Backup-Punkt, listet `{ vault-path → { hash, size, mtime } }` + `deleted: string[]` (Paths, die seit Parent entfernt wurden) + Metadaten (snapshot-type: `full|inc`, device-id, parent-snapshot-id, created-at, vault-name).

**Vorteile:**
- Full = Manifest enthält Einträge für *alle* existierenden Paths, `deleted` leer.
- Inc = Manifest enthält Einträge nur für *neue oder geänderte* Paths; `deleted` listet explizit seit Parent entfernte Paths.
- Retention = Manifeste löschen + GC über `content/` (gelöscht wird, was kein Manifest mehr referenziert).

**Manifest-Merge (Restore zu Zeitpunkt T):**

1. Parent-Chain von Snapshot `T` aufwärts verfolgen bis zum nächsten Full-Ancestor `F` (inkl.).
2. Ergebnis-Map initialisieren aus `F`.
3. Incs in chronologischer Reihenfolge (ältester → T) iterieren:
   - Für jeden Path in `manifest.files`: überschreiben (last-write-wins).
   - Für jeden Path in `manifest.deleted`: aus Ergebnis-Map entfernen.
4. Ergebnis = exakter Vault-Zustand zu Zeitpunkt T.

**Deletion-Semantik:** Ein Path, der in einem Inc weder in `files` noch in `deleted` auftaucht, gilt als **unverändert** (aus Parent geerbt). Ein Path in `deleted` erzeugt einen expliziten Tombstone, der bei Merge berücksichtigt wird. So sind „not-changed-since-parent" und „explicitly-removed" sauber unterscheidbar.

**Garbage Collection (GC):**
- Nach Retention-Cleanup: Plugin listet alle verbleibenden Manifests, baut Set aller referenzierten Hashes, listet `content/` via `files/list_folder`, löscht Hashes, die im Set fehlen.
- GC läuft asynchron nach erfolgreichem Retention-Pass, nicht im Backup-Hotpath.

### 4.2 Change Detection — Hybrid (Events + Reconcile)

Zwei Eingangskanäle:

1. **Vault-Events (live):** Obsidian's `vault.on('create' | 'modify' | 'delete' | 'rename')` füttern eine Queue (`pending_changes.json` im Plugin-Data-Verzeichnis).
2. **Reconcile-Scan (Safety-Net):** vor jedem Backup-Lauf: `app.vault.getFiles()` enumerieren, jeden Path gegen den lokalen Index (`{ path → hash, mtime, size }`) prüfen. Bei `mtime`/`size`-Mismatch → Inhalt lesen + hashen, zur Queue hinzufügen.

Diese Kombination deckt ab:
- Obsidian Sync (Events feuern) — Queue reicht
- iCloud / Syncthing / Git Pull / Dropbox-Desktop-App / `cp` (keine Events) — Reconcile fängt auf
- Plugin-Crash / vergessene Queue-Einträge — Reconcile fängt auf

**Performance:** bei 10k+ Files ist Reconcile ein `stat`-Only-Scan (mtime + size), keine Reads. Geschätzt <2s. Inhalts-Lesen passiert nur bei Mismatch (≈5 Files/Tag im Zielprofil).

**Lokaler Index** liegt in Plugin-Data (`index.json`): Single-Source-of-Truth für „was hat das Backup-Gerät zuletzt gesehen". Wird **nicht** über Obsidian Sync synchronisiert — die Designated-Device-Regel macht das unnötig.

### 4.3 Backup-Kadenz (Schema C — „Paranoid")

- **Full:** wöchentlich (So. 03:00 lokal)
- **Incremental:** alle 15 min, aber **nur wenn Queue nicht leer** (event-driven)
- **Quiet-Period:** nach App-/Plugin-Load **10 min Grace** (Obsidian Sync / iCloud haben Zeit zum Durchsyncen), danach **2 min ohne Vault-Event** als Ruhe-Heuristik, bevor der erste Backup-Lauf startet
- **Pre-flight Notice** (5 min vor Fulls): Notice + Ribbon-Highlight *„Archivist: Weekly full starts in 5 min. [Start now] [Postpone 1h] [Skip]"*
- **Catch-up:** beim Startup wird `last_success_per_tier` geprüft. Überfällige Fulls/Incs queuen sich als Catch-up-Jobs (laufen nach Quiet-Period).

### 4.4 Retention-Policy

Hierarchische Tiers, Default-Werte (alle konfigurierbar):

| Tier | Keep-Regel | Default-Werte (min–max) |
|---|---|---|
| **Never-Prune-Window** | alles innerhalb letzter N Tage, **Override über alle anderen Tiers** | 14 Tage (0 = deaktiviert bis 14) |
| Recent | alles innerhalb letzter H Stunden | 24 h (0–168) |
| Hourly | jüngster Snapshot pro Stundenfenster, für D Tage | 7 Tage (0–30) |
| Daily | jüngster pro Tagesfenster, für D Tage | 30 Tage (0–90) |
| Weekly | jüngster pro Wochenfenster, für M Monate | 6 Monate (0–24) |
| Monthly | jüngster pro Monatsfenster, für Y Jahre | 3 Jahre (0–10) |

**Auswertungsreihenfolge (Retention-Pass):**

Für jeden Snapshot wird in dieser Reihenfolge geprüft — **erste zutreffende Regel gewinnt**:

1. `age < never_prune_window_days` → **keep** (überschreibt alles, auch bei `never_prune=0` wird diese Regel übersprungen).
2. `age < recent_hours` → **keep**.
3. Snapshot ist jüngster im aktuellen Stundenfenster UND `age < hourly_days` → **keep**.
4. Snapshot ist jüngster im Tagesfenster UND `age < daily_days` → **keep**.
5. Snapshot ist jüngster im Wochenfenster UND `age < weekly_months * 30` → **keep**.
6. Snapshot ist jüngster im Monatsfenster UND `age < monthly_years * 365` → **keep**.
7. sonst → **delete** (Manifest unlinken, GC folgt später).

**Chain-Integritäts-Override:** Bevor ein Full gelöscht wird, prüfen ob Incs mit `parent == this.id` noch unter Regel 1–6 fallen. Falls ja: Full bleibt, auch wenn er selbst pruneable wäre. Ein verwaister Full ohne Inc-Kinder wird normal gelöscht.

**Full-vs-Inc in den Tiers:** Jede Regel matcht beide Typen. Tier-Buckets mischen Full und Inc — was zählt, ist der jüngste Snapshot im Fenster.

**Datenverlust-Klärung:** Retention löscht **Manifests**, nicht File-Contents. File-Contents überleben in `content/`, solange *irgendein* verbleibender Snapshot sie referenziert. Was durch Retention verloren geht: **Zwischenzustände** eines Files, die zwischen zwei behaltenen Snapshots nie „gelandet" sind. Beim Zielprofil (~5 Änderungen/Tag) ist das vernachlässigbar; beim Never-Prune-Window garantiert lückenlos.

**Storage-Estimate (Referenz-User):** ~90 GB Ceiling bei 2 GB-Vault. Unter 5% des 2 TB-Plans.

### 4.5 Device-Coordination — Designated Device

- Settings-Toggle: **„This device performs backups"** (nur ein Device aktiv).
- Jedes Device hat eine persistente `device_id` (im Plugin-Data, generiert beim ersten Load).
- **Passive Devices:** Queue läuft mit (falls sie später Backup-Owner werden), aber keine Uploads. Ribbon zeigt „passive" Icon.
- Manifest-Feld `device_id` dokumentiert den schreibenden Owner für spätere Debug/Takeover-Szenarien.
- **File-Mtime-Problem:** Obsidian Sync / iCloud modifizieren FS-mtime beim Sync. Deshalb nutzen wir **`TFile.stat.mtime` aus dem Obsidian-Objekt** (inhaltsbezogen), nicht FS-mtime. Im Manifest wird `TFile.stat.mtime` persistiert.

**Takeover:** V1 manuell — User schaltet alten Owner ab, neuen an. Dynamischer Takeover (48h-Timeout) ist im Parking-Lot für V2.

## 5. Restore — File-Level Browser + Preview (Tier 2)

### 5.1 Plugin-Tab „Backup Browser"

Öffnung via Command Palette (`Archivist: Open Backup Browser`) oder zweitem Ribbon-Button. Öffnet sich als `WorkspaceLeaf` mit custom `ItemView` — kein Modal, sondern vollwertiger Tab mit 3-Spalten-Layout:

```
┌─ Snapshots ──┐┌─ Files @ Snapshot ──┐┌─ Preview ─────────────────┐
│ Today         ││ 📁 Daily             ││ # 2026-04-23               │
│  14:00 · inc  ││  📁 2026-04          ││ ## Meetings               │
│  13:00 · inc  ││   📄 2026-04-23.md   ││ - ...                     │
│ Yesterday     ││ 📁 Projects          ││                           │
│  22:00 · inc  ││ 📁 Attachments       ││ [Restore in place]        │
│ This month    ││                      ││ [Restore as copy]         │
│  Apr 01 · full││                      ││ [Copy content]            │
└───────────────┘└──────────────────────┘└───────────────────────────┘
```

- **Restore in place:** überschreibt den Live-Vault-Path (mit Bestätigungsdialog).
- **Restore as copy:** speichert als `<path>.restored-<timestamp>.md` neben Original.
- **Copy content:** nur Inhalt in die Zwischenablage.

### 5.2 File-History Command

Command Palette (`Archivist: Show history of current file`) → Modal mit Versionsliste des aktiv geöffneten Files:

```
📄 Daily/2026-04/2026-04-23.md — 8 Versionen
 🟢 Heute 14:00 · 2.1 KB · aktuell im Vault        [now]
    Heute 13:00 · 1.9 KB
    Heute 11:00 · 1.8 KB
    Heute 09:00 · 1.2 KB · [initial today]
    Gestern 22:00 · 1.1 KB
    Apr 15 · 0.8 KB · [weekly]
[Restore this version] [Preview]
```

Schnelllösung für das Kern-Problem „wann war die letzte Änderung?".

**V1-Scope:** Versionsliste zeigt Timestamps, Größe und Tier-Tag (Inc/Weekly/Monthly). **Kein** Byte-Diff, **kein** Zeilen-Diff — reines Preview-based Comparing. Diff-Feature ist im Parking-Lot für V2 (Abschnitt 10).

### 5.3 Status-Surface

Kein Sidebar-Leaf. Status kommt über:

- **Ribbon-Icon-Tooltip:** letzter erfolgreicher Backup, nächster geplanter, Overdue-Warnung.
- **Toast-Notices:** Pre-flight (5 min vor Full), Upload-Abschluss (optional, konfigurierbar), Fehler.

## 6. Settings

```
Archivist Settings
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Backup Schedule
  [x] This device performs backups  (Device ID: abc123)
  Full backup cadence:      [ weekly ▾ ]
  Full backup day/time:     [ Sunday 03:00 ▾ ]
  Incremental interval:     [ 15 min ▾ ]
  Active window:            [ 08:00 – 22:00 ]  (incrementals only)
  Startup grace period:     [ 10 min ▾ ]
  Quiet period after startup: [ 2 min ▾ ]

Retention
  Never-prune window:       [ 14 ▾ ] days  (range 0–14, 0 = disabled)
  Recent:                   alles in letzter [ 24 h ▾ ]
  Hourly:                   1/h für [ 7 ▾ ] Tage
  Daily:                    1/d für [ 30 ▾ ] Tage
  Weekly:                   1/w für [ 6 ▾ ] Monate
  Monthly:                  1/m für [ 3 ▾ ] Jahre

Notifications
  [x] Pre-flight notice 5 min before full
  [ ] Toast after successful incremental
  [x] Toast after successful full
  [x] Toast on errors

Advanced
  [x] Reconcile scan before each backup  (recommended)
  [ ] Exclude paths matching glob:  [ .trash/**, _templates/** ]
  [ ] Dry-run mode (show what would happen)
  Vault path prefix in Dropbox: [ Archivist/<VAULT_NAME> ]

Dropbox
  Status: ✅ Connected as marcus@...
  [Re-authenticate] [Disconnect]
```

## 7. Dropbox Integration

### 7.1 Required Scopes

- `files.content.write` — Upload, Delete (via `files/delete_v2`)
- `files.content.read` — für Restore (Download von Blobs) und GC (`files/list_folder`)
- `files.metadata.read` — Listing, Manifest-Lesen

→ **README und Plugin-Beschreibung müssen explizit machen**, dass Read-Zugriff nötig ist. Scope ist per `--scope` nur auf `Apps/Archivist/*` beschränkt (App-Folder-Mode), nicht auf den gesamten Dropbox-Account.

### 7.2 Auth-Flow

- PKCE-OAuth wie bisher (`getAuthenticationUrl` + `getAccessTokenFromCode`).
- Code-Verifier wird **nicht** als modul-level `let` gespeichert (Bug des Alt-Plugins), sondern in einem Map-Store des Plugin-Objekts, keyed per state-parameter.
- Token-Refresh automatisch vor jedem API-Call, nicht nur beim Startup.

### 7.3 Chunked Uploads

Files > 150 MB: `files/upload_session/start` → `append` → `finish`. Chunk-Size 8 MB. Retry mit exponential Backoff bei 429/5xx.

### 7.4 Rate Limiting

Max. N parallele Uploads (Default 4, konfigurierbar). Bei `429 Too Many Requests`: Honor `Retry-After`-Header, Queue pausieren.

## 8. Mobile Strategy

- **Kein Scheduling** auf Mobile. Background-Worker sind in Obsidian Mobile nicht stabil.
- **Manual Trigger erlaubt:** Ribbon-Button macht sofortigen Incremental. Als Option in Settings (`[x] Allow manual backup on mobile`) default on.
- **Browse + Restore:** Plugin-Tab funktioniert auf Mobile (evtl. Layout auf 1-Spalten-Stack). File-History-Command auch.
- **Kein Event-Listener, keine persistente Queue auf Mobile** — weder als Owner noch passiv. Mobile-Geräte sind per se keine Designated-Devices (Setting-Toggle ist auf Mobile deaktiviert). Das überschreibt Abschnitt 4.5, wo „Queue läuft mit bei passiven Devices" sich nur auf **Desktop-passiv** bezieht. Jeder Mobile-Backup-Lauf macht immer einen Full-Reconcile gegen den Vault.

## 9. Tech Stack

- **TypeScript** strict (strict: true, incl. strictNullChecks)
- **Build:** esbuild statt rollup (schneller, Obsidian-Standard inzwischen)
- **Dropbox SDK:** `dropbox@latest` via npm, **nicht vendored**
- **Testing:** Vitest für Unit + Integration. Mock `Vault`-Adapter + Dropbox-Client.
- **Linting:** ESLint + Prettier
- **Obsidian-API:** `minAppVersion` auf aktuelles Major setzen (≥ 1.5)

## 10. Open Questions & Parking Lot

- **Parking V2:** Full-Vault-Restore (Wipe+Replace) mit Disaster-Recovery-Confirmation.
- **Parking V2:** Dynamischer Device-Takeover nach 48h-Silent.
- **Parking V2:** Timeline-Visualisierung aller Snapshots (horizontale Scrollbar).
- **Parking V2:** Export Snapshot als Zip.
- **Parking V2:** Alternative Backends (S3-compatible, Google Drive).
- **Parking V2:** Full-Text-Search über Snapshots.
- **Parking V2:** Diff-Viewer (Zeilen-/Wort-Diff zwischen zwei Snapshot-Versionen einer Datei).
- **Offen V1:** Migration vom alten `obsidian-dropbox-backups`-Plugin? Vorschlag: **keine automatische Migration**. Altes Plugin deaktivieren, Archivist frisch authentifizieren, alte Backups bleiben im alten Dropbox-Ordner unangetastet. Release-Notes verlinken zur Deaktivierungs-Anleitung.
- **Offen V1:** Lokalisierung — V1 Englisch only. i18n-Hook vorsehen, Strings zentralisieren.

## 11. Approaches Considered & Rejected

| Approach | Abgelehnt, weil |
|---|---|
| Binary-Diff-Incrementals (rsync-style) | Für kleine Markdown-Files zu viel Overhead, fehleranfällig bei binärer Patch-Anwendung. CAS ist überlegen. |
| Dynamic-Lease für Device-Coordination | Komplexität + Read-Scope-Eventual-Consistency nur für seltenen Edge-Case. „Designated" deckt 95% ab. |
| Sidebar-Leaf als Status-Surface | Workspace-Real-Estate-Kosten übersteigen Nutzen. Ribbon-Tooltip + Toasts reichen. |
| Events-Only Change Detection | External-Sync-Tools unsichtbar. Reconcile als Safety-Net ist billig und macht das Plugin robust gegen User-Variation. |
| Full-Every-20-min + Retention | Die Kombination, die das alte Plugin hatte. Traffic + API-Last auch mit Retention zu hoch. Inc-basiert ist ~1000× günstiger im Zielprofil. |

## 12. Success Criteria (V1)

- Automatisches Backup läuft über 4 Wochen ohne manuellen Eingriff und ohne Dropbox zu überfluten (Storage-Ceiling < 100 GB bei Ziel-Vault).
- Restore einer File-Version, die 5 Tage alt ist, in ≤ 30 Sekunden User-Zeit (inkl. UI-Navigation).
- Externer Sync-Tool-Test (iCloud oder Git-Pull): modifiziertes File wird im nächsten Inc erkannt und gesichert.
- Kein Backup-Lauf während Quiet-Period / Grace-Period.
- Pre-flight Notice feuert reproduzierbar 5 min vor Full.
- Zwei Geräte: nur das „designated" lädt hoch, das andere zeigt „passive".
