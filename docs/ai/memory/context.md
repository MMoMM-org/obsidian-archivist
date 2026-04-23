# Context Memory

<!-- 2026-04-23 -->
- **Spec 001-archivist-plugin is Ready** on branch `feat/xdd-001-archivist-plugin` (10 commits, zero implementation code yet). 20 ADRs all user-approved, 10 phases with ~70 TDD tasks, 25/25 multi-reviewer findings addressed. Next step: **Phase 1 (Foundation & Scaffolding)**.
- **Dropbox app registered for V1**: App name `ObsidianArchivist` (globally unique Dropbox requirement) / app-folder name `Archivist` / CLIENT_ID `aanoqah5sn73rjb`. App-folder path: `/Apps/Archivist/<VAULT_PREFIX>/`. Publisher: Marcus Breiden. Privacy Policy URL: `https://github.com/MMoMM-org/obsidian-archivist/blob/main/PRIVACY.md`. CLIENT_ID lands as a compile-time constant in `src/config/dropbox.ts` during Phase 3 T3.3.
- **Outstanding before V1 public release (non-code)**: push repo to `github.com/MMoMM-org/obsidian-archivist` so the Privacy Policy URL resolves; upload 512×512 PNG app icon to the Dropbox app page and the ribbon SVG for the community listing (Phase 10 T10.6a).
- **Scope decisions locked**: Mobile deferred post-V1 (`isDesktopOnly: true`, PRD W8a captures re-add plan). Retention 3-tier MVP (never-prune + recent / daily / monthly; hourly and weekly tiers dropped, may return post-V1). No telemetry in V1. No client-side encryption in V1 (trade-off with CAS dedup; deferred).
