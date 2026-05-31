# Brand assets

All icons and logos in this folder are **original work, MIT-licensed** alongside the rest of the plugin (see `LICENSE` at the repo root).

## Files

| Path | Format | Use |
|------|--------|-----|
| `../src/ui/icons/ribbon.svg` | 20×20 SVG, `currentColor` only | Obsidian ribbon icon. Lives in `src/` because it's bundled into the plugin and theme-respecting. |
| `icons/archivist-icon.svg` | 256×256 SVG, hard-coded brand colours | Canonical brand icon source — same folder + back-arrow motif as the ribbon, rendered as a filled tile so it reads on light Dropbox screens AND on Obsidian listing cards. Rasterised to the PNGs below. |
| `icons/plugin-logo-64.png` | 64×64 PNG with alpha | Small icon use (favicon-style, READMEs, social previews). |
| `icons/plugin-logo-128.png` | 128×128 PNG with alpha | Mid-density icon use (retina favicons, app shelves). |
| `icons/plugin-logo-256.png` | 256×256 PNG with alpha | Obsidian community-plugin listing card. |
| `icons/dropbox-app-512.png` | 512×512 PNG with alpha | Dropbox developer console — uploaded to the OAuth consent screen. |
| `icons/render.sh` | Bash script | Re-rasterises every PNG above from `archivist-icon.svg`. Run from anywhere: `bash assets/icons/render.sh`. |

## Design direction

- **Motif**: a folder with a backward-pointing arrow inside, meaning "version history of a vault." Simple, monochrome-friendly so it works with arbitrary Obsidian themes.
- **Constraint**: the ribbon SVG MUST use `currentColor` (no hard-coded fill or stroke colors). Verified by `grep -i 'fill="#\|stroke="#' src/ui/icons/ribbon.svg` returning nothing.
- **Smallest effective size**: 16×16. The ribbon SVG was authored at 20×20 viewBox so it scales cleanly to 16×16 without strokes collapsing.
- **Brand icon** (`icons/archivist-icon.svg`) uses fixed brand colours (`#8B5CF6` → `#5B3FB8` background gradient, off-white folder, deep purple arrow) because it has to render on Dropbox's light OAuth surface and on a listing card without theme inheritance. Different rules from the ribbon — that's intentional, not a violation of the constraint above.

## Re-rendering brand PNGs

The PNGs in `icons/` are derived from `icons/archivist-icon.svg`. Edit the SVG, then:

```bash
bash assets/icons/render.sh
```

Requires `npx` (uses `@resvg/resvg-js-cli` on-demand — no persistent devDep).

## Theme verification

When changing the ribbon SVG, manually verify it renders correctly in:

1. Obsidian's default light theme.
2. Obsidian's default dark theme.
3. At least one popular community theme (e.g. *Minimal*, *Things*, *Catppuccin*).

The SVG uses `currentColor`, so it inherits the ribbon-icon color from each theme — but it's worth double-checking that strokes are visible and don't collapse at 16×16.
