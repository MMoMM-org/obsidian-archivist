#!/usr/bin/env bash
# Re-render the Dropbox app icon from the canonical SVG.
# Source of truth: archivist-icon.svg (256×256 viewBox).
# Run from repo root:  bash assets/icons/render.sh
set -euo pipefail

cd "$(dirname "$0")"

npx --yes @resvg/resvg-js-cli --fit-width 512 archivist-icon.svg dropbox-app-512.png

echo "Done: $(pwd)/dropbox-app-512.png"
