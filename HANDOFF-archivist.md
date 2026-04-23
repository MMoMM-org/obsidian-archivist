# Archivist — Project Handoff

> Für die erste Session im neuen Repo. Diese Datei + die Spec sind alles, was du brauchst.

## Was ist Archivist

Neues Obsidian-Plugin für versionierte Vault-Backups auf Dropbox mit Content-Addressed Storage, hierarchischer Retention und File-Level-Restore.

- **Display Name:** Archivist
- **Tagline:** „Your vault's quiet historian."
- **Plugin-ID:** `obsidian-archivist`
- **License:** MIT

## Primäre Artefakte

| Datei | Zweck |
|---|---|
| `2026-04-23-archivist-plugin.md` | **Source of Truth.** Vollständige Design-Spec. Feed für `/xdd`. |
| `HANDOFF-archivist.md` | Diese Datei. Kontext + Referenzen. |

## Nächster Schritt

Im neuen Repo: `/xdd 2026-04-23-archivist-plugin.md` → erzeugt PRD, SDD, Implementierungsplan. Danach `/implement`.

## Kontext aus dem Brainstorm (2026-04-23)

Die Spec ist bereits vom Reviewer-Agent approved. Die folgenden Punkte sind die nicht-offensichtlichen Design-Entscheidungen, damit du in der Implementierung nicht nochmal durchspielen musst, warum es so ist:

### Warum CAS statt klassischer Full/Inc-Chain

Klassische Backup-Chains (Full + Diff-Chain) verlieren echte Daten, wenn Incs durch Retention gelöscht werden. CAS entkoppelt **Snapshot-Identität** (Manifest) von **Content-Persistenz** (Blob-Store). Retention löscht nur Manifests; Blobs überleben, solange *irgendein* Manifest sie referenziert. Siehe Spec §4.1.

### Warum „Designated Device" statt Lease

User hat zwei Geräte (Desktop + Mobile-read-only). Dynamisches Lease-basiertes Ownership wäre Overkill für diesen Fall und braucht Dropbox-Read-Scope für den Lease-File-Check — plus Eventual-Consistency-Probleme. Designated ist deterministisch und reicht. Parking für V2: 48h-Silent-Takeover-Dialog.

### Warum Events + Reconcile (nicht Events-only)

Obsidian-Vault-Events feuern **nur** bei Änderungen, die durch Obsidian selbst gehen. iCloud, Syncthing, Git-Pull, Dropbox-Desktop-App schreiben „unter" Obsidian — keine Events. Reconcile-Scan vor jedem Backup-Lauf fängt das auf. Kostet bei 10k Files ~2s (stat-only, nur Hash bei Mismatch).

### Warum Never-Prune-Window max 14 Tage

User-Entscheidung: 14 Tage ist die Grenze, innerhalb der „Ich habe gestern etwas kaputtgemacht, finde es"-Szenarien abgedeckt sein müssen. Darüber hinaus greift Retention. 0 = Feature deaktiviert.

## Analyse des Vorgängers — was wir explizit anders machen

Referenz (kann jederzeit gelöscht werden, nur als Lesson-Learned):
- Ehemaliger Repo: `https://github.com/ryanpcmcquen/obsidian-dropbox-backups` (letzter Commit 2024-06, ~22 Monate Stillstand)
- Fork war benannt als: `https://github.com/MMoMM-org/obsidian-dropbox-backups` (von Marcus, wurde verworfen zugunsten eines frischen Repos)

**Konkrete Bugs / Anti-Patterns, die wir vermeiden:**

1. **Full-every-20-min ohne Retention** → Dropbox läuft voll. → Wir: Inc-only mit Retention-Cleanup.
2. **`this.app.vault.adapter.exists()` ohne `await`** → Promise ist truthy, Check wertlos. → Wir: überall strict-async, ESLint-Regel.
3. **`currentBackupTime` als Abbruch-Flag** → Race zwischen parallelen Backups. → Wir: explizite Lock + CancellationToken.
4. **Module-level `let dropboxBackupsCodeVerifier`** → fragil bei parallelen Auth-Flows. → Wir: Map keyed per state-Parameter im Plugin-Objekt.
5. **Keine Chunked Uploads** → Files > 150 MB failen still. → Wir: `upload_session` mit 8 MB Chunks.
6. **Binary-Detection per Extension-Whitelist `md|org|txt`** → falsch für `.canvas`, `.excalidraw.md`. → Wir: Dropbox's eigenes content-hash-Scheme für Dedup, keine extension-basierte Sonderbehandlung.
7. **Vendored Dropbox-SDK (105 KB im Repo)** → keine Security-Updates. → Wir: `dropbox@latest` via npm.
8. **Keine Tests, kein CI** → jede Änderung Blindflug. → Wir: Vitest + GitHub Actions ab Tag 1.

## User-Profil / Default-Kalibrierung

Defaults in der Spec sind auf diesen Primary-User optimiert, bleiben aber konfigurierbar:

- Vault: 10k+ Files, ~2 GB, überwiegend Markdown
- Dropbox: 2 TB-Plan (Storage ist nicht Engpass)
- Änderungen: ~5 Files/Tag
- Devices: Desktop (designated) + Mobile (read-only)
- Schema: C „Paranoid" mit 14d Never-Prune-Window

## Offene Punkte, die bei Implementierung entschieden werden

Nichts Blockierendes, aber wert zu wissen:

- **Catch-up-Strategie Details:** Wenn 3 Weeklies überfällig sind nach 3 Wochen Pause — macht Plugin 1 oder 3 nach? Spec sagt „überfällige Tiers queuen sich". Vorschlag bei Implementierung: **1 Full sofort + Flag „previous missed"**, keine 3 sequentiell. Entscheidung ins SDD.
- **Toasts-Default für Incs:** Spec hat „Toast after successful incremental" als `[ ]` (aus). Bestätigt lassen — sonst spamt es bei 96 Incs/Tag.
- **Mobile-UI-Breakpoint:** Plugin-Tab hat 3-Spalten-Layout. Auf Mobile sollte das ein Stack werden. Breakpoint via CSS-Media-Query (Obsidian setzt `.is-mobile` an `body`).

## Wenn du diesen Handoff nicht mehr brauchst

Sobald das Plugin in einem frischen Repo liegt und `/xdd` gelaufen ist: dieses File kann weg. Die Spec ist self-contained. Lesson-Learned-Abschnitt oben kann in ein `docs/rationale.md` wandern oder als ADR persistiert werden.
