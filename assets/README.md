# Brand assets

All icons and logos in this folder are **original work, MIT-licensed** alongside the rest of the plugin (see `LICENSE` at the repo root).

## Files

| Path | Format | Use |
|------|--------|-----|
| `../src/ui/icons/ribbon.svg` | 20×20 SVG, `currentColor` only | Obsidian ribbon icon. Lives in `src/` because it's bundled into the plugin and theme-respecting. |
| `icons/dropbox-app-512.png` | 512×512 PNG with alpha | Dropbox developer console — uploaded to the OAuth consent screen. Pending: file is to be authored before v0.1.0 release. |
| `icons/plugin-logo-256.png` | 256×256 PNG with alpha | Obsidian community-plugin listing card. Optional — ship if available. Pending. |

## Design direction

- **Motif**: a folder with a backward-pointing arrow inside, meaning "version history of a vault." Simple, monochrome-friendly so it works with arbitrary Obsidian themes.
- **Constraint**: the ribbon SVG MUST use `currentColor` (no hard-coded fill or stroke colors). Verified by `grep -i 'fill="#\|stroke="#' src/ui/icons/ribbon.svg` returning nothing.
- **Smallest effective size**: 16×16. The ribbon SVG was authored at 20×20 viewBox so it scales cleanly to 16×16 without strokes collapsing.

## Pending work for v0.1.0 release

- [ ] Author `dropbox-app-512.png` and upload to <https://www.dropbox.com/developers/apps/info/<app-id>>.
- [ ] Verify the icon displays correctly on the Dropbox OAuth consent screen (real test, not just local).
- [ ] (Optional) Author `plugin-logo-256.png` for the community-plugin listing card.

## Theme verification

When changing the ribbon SVG, manually verify it renders correctly in:

1. Obsidian's default light theme.
2. Obsidian's default dark theme.
3. At least one popular community theme (e.g. *Minimal*, *Things*, *Catppuccin*).

The SVG uses `currentColor`, so it inherits the ribbon-icon color from each theme — but it's worth double-checking that strokes are visible and don't collapse at 16×16.
