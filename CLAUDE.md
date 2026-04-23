# Archivist

Your vault's quiet historian. Versioned vault backups to Dropbox with content-addressed storage, hierarchical retention, and file-level restore.

@~/Kouzou/standards/general.md

## Project Files
@~/Kouzou/projects/miyo/team.md

## Memory & Context
@docs/ai/memory/memory.md

## Routing Rules
- Repo conventions/style → docs/ai/memory/general.md
- Tool/CI/build knowledge → docs/ai/memory/tools.md
- Domain/business rules → docs/ai/memory/domain.md
- Architectural decisions → docs/ai/memory/decisions.md
- Current focus/blockers → docs/ai/memory/context.md
- Bugs/fixes → docs/ai/memory/troubleshooting.md

## Build Commands
```bash
npm run build        # TypeScript check + esbuild production build
npm test             # vitest unit tests
npm run lint         # eslint with obsidianmd rules
npm run dev          # esbuild watch mode (development)
npm run test:watch   # vitest watch mode
npm run test:coverage # vitest with v8 coverage
```

## Rules
- Use Plan Mode for any change touching more than 2 files
- Commit after every completed task
- When changes affect other repos → create handoff in _outbox/

## Docker Environment
This repo uses the `archivist` Docker build variant → image `claude-code-archivist`. Derived from the `secure` stage and adds plugin-dev tools beyond the standard setup:
- `rsync` — local vault mirror tests
- `httpie` — Dropbox API debugging (OAuth / upload_session flow)
- `zstd`, `xz-utils` — compression experiments

**Template source:** `miyo-kouzou/claude-docker/claude-docker-template/Dockerfile` (stage `archivist`, since template_version 1.2). Local edits to the rendered `claude-docker/` output are overwritten on the next `claude-docker-update.sh` — customization belongs in the Kouzou template.

**Rebuild:** run `~/Kouzou/scripts/claude-docker-update.sh` from the repo root.
