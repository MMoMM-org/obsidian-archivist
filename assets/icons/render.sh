#!/usr/bin/env bash
# Re-render the canonical brand icon to all shipped PNG sizes.
# Source of truth: archivist-icon.svg (256×256 viewBox).
# Run from repo root:  bash assets/icons/render.sh
set -euo pipefail

cd "$(dirname "$0")"
SRC="archivist-icon.svg"

render() {
    local width="$1" out="$2"
    npx --yes @resvg/resvg-js-cli --fit-width "$width" "$SRC" "$out"
}

render 64  plugin-logo-64.png
render 128 plugin-logo-128.png
render 256 plugin-logo-256.png
render 512 dropbox-app-512.png

echo "Done. PNGs in $(pwd)"
