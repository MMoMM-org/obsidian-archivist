#!/usr/bin/env bash
# Re-render Dropbox app icons from the canonical SVG.
# Source of truth: archivist-icon.svg (256×256 viewBox).
# Run from repo root:  bash assets/icons/render.sh
set -euo pipefail

cd "$(dirname "$0")"
SRC="archivist-icon.svg"

render() {
    local width="$1" out="$2"
    npx --yes @resvg/resvg-js-cli --fit-width "$width" "$SRC" "$out"
}

render 64  dropbox-app-64.png
render 256 dropbox-app-256.png

echo "Done. PNGs in $(pwd)"
