# Brand assets

All icons and logos in this folder are **original work, MIT-licensed** alongside the rest of the plugin (see `LICENSE` at the repo root).

## Files

| Path | Format | Use |
|------|--------|-----|
| `../src/ui/icons/ribbon.svg` | 20×20 SVG, `currentColor` only | Obsidian ribbon icon. Lives in `src/` because it's bundled into the plugin and theme-respecting. |
| `icons/archivist-icon.svg` | 256×256 SVG, hard-coded brand colours + Lucide `archive` (ISC) | Source for the Dropbox app icon — the same Lucide icon community.obsidian.md renders next to the plugin name, on a brand-purple tile so it reads on Dropbox's light OAuth consent screen. |
| `icons/dropbox-app-64.png` | 64×64 PNG with alpha | Dropbox developer console — small app-icon slot. Rendered from `archivist-icon.svg`. |
| `icons/dropbox-app-256.png` | 256×256 PNG with alpha | Dropbox developer console — large app-icon slot. Rendered from `archivist-icon.svg`. |
| `icons/render.sh` | Bash script | Re-rasterises both Dropbox PNGs from `archivist-icon.svg`. Run: `bash assets/icons/render.sh`. |

## Design direction

- **Motif**: a folder with a backward-pointing arrow inside, meaning "version history of a vault." Simple, monochrome-friendly so it works with arbitrary Obsidian themes.
- **Constraint**: the ribbon SVG MUST use `currentColor` (no hard-coded fill or stroke colors). Verified by `grep -i 'fill="#\|stroke="#' src/ui/icons/ribbon.svg` returning nothing.
- **Smallest effective size**: 16×16. The ribbon SVG was authored at 20×20 viewBox so it scales cleanly to 16×16 without strokes collapsing.
- **Dropbox app icon** (`icons/archivist-icon.svg` → `dropbox-app-64.png` + `dropbox-app-256.png`) uses **Lucide `archive`** (ISC-licensed, lucide-static v1.17.0) on a fixed brand-purple tile (`#8B5CF6` → `#5B3FB8` gradient, white strokes). The icon choice deliberately matches what community.obsidian.md already shows next to "Archivist" in its plugin listing — so users see a familiar shape on the Dropbox OAuth consent screen rather than an unfamiliar custom mark. The tile (instead of a bare Lucide line drawing) gives the icon visual weight against Dropbox's light surface. Different rules from the ribbon SVG — that's intentional, not a violation of the constraint above.

## Re-rendering the Dropbox icons

```bash
bash assets/icons/render.sh
```

Requires `npx` (uses `@resvg/resvg-js-cli` on-demand — no persistent devDep). Edit the SVG, then re-run. The two PNGs match Dropbox's developer-console small (64×64) and large (256×256) app-icon slots.

## Theme verification

When changing the ribbon SVG, manually verify it renders correctly in:

1. Obsidian's default light theme.
2. Obsidian's default dark theme.
3. At least one popular community theme (e.g. *Minimal*, *Things*, *Catppuccin*).

The SVG uses `currentColor`, so it inherits the ribbon-icon color from each theme — but it's worth double-checking that strokes are visible and don't collapse at 16×16.
