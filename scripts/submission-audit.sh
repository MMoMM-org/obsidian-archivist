#!/usr/bin/env bash
# Pre-submission audit (T10.6).
#
# Runs the manual checklist for the Obsidian Community Plugin submission:
#   - manifest.json + versions.json shape
#   - GitHub Release artifacts present (after release.sh)
#   - main.js: no eval, no innerHTML on user content, no undeclared hosts
#   - isDesktopOnly matches the manifest
#
# Exit non-zero on any failure so this can run in CI before submission.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "${SCRIPT_DIR}/.." && pwd )"
cd "${REPO_ROOT}"

step() { printf "\n\033[1;34m▸ %s\033[0m\n" "$*"; }
ok()   { printf "\033[1;32m  ✓ %s\033[0m\n" "$*"; }
fail() { printf "\033[1;31m  ✗ %s\033[0m\n" "$*"; exit 1; }

step "manifest.json — required fields"
for field in id name version minAppVersion description author isDesktopOnly; do
  if ! grep -qE "\"${field}\"[[:space:]]*:" manifest.json; then
    fail "manifest.json is missing field: ${field}"
  fi
done
ok "all required manifest fields present"

step "versions.json — version-to-minAppVersion map"
[ -f versions.json ] || fail "versions.json missing"
MANIFEST_VERSION=$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' manifest.json | sed -E 's/.*"([^"]+)"$/\1/')
if ! grep -qE "\"${MANIFEST_VERSION}\"" versions.json; then
  fail "versions.json missing entry for current manifest version (${MANIFEST_VERSION})"
fi
ok "versions.json maps ${MANIFEST_VERSION}"

step "isDesktopOnly: true"
if ! grep -qE '"isDesktopOnly"[[:space:]]*:[[:space:]]*true' manifest.json; then
  fail "manifest.json is missing isDesktopOnly: true"
fi
ok "desktop-only declared"

step "main.js (built bundle) audit"
if [ ! -f main.js ]; then
  fail "main.js does not exist — run npm run build first"
fi

if grep -qE 'eval[[:space:]]*\(' main.js; then
  fail "main.js contains eval()"
fi
ok "no eval"

if grep -qE '\.innerHTML[[:space:]]*=' main.js; then
  fail "main.js contains innerHTML assignment"
fi
ok "no innerHTML assignments"

# Declared hosts only. Match only quoted URL-like strings (`https://host/...`)
# to avoid false positives from JS property access like `this.queue.com`.
ALLOWED_HOSTS_RE='api\.dropboxapi\.com|content\.dropboxapi\.com|www\.dropbox\.com'
SMUGGLED=$(grep -oE 'https?://[a-z0-9.-]+' main.js | sed -E 's,^https?://,,' | grep -vE "^(${ALLOWED_HOSTS_RE})$" | sort -u || true)
if [ -n "${SMUGGLED}" ]; then
  fail "main.js references undeclared hosts:\n${SMUGGLED}"
fi
ok "only declared hosts referenced"

step "Release artifacts (run after scripts/release.sh)"
if [ -d dist ]; then
  for asset in main.js manifest.json restore.mjs; do
    [ -f "dist/${asset}" ] || fail "dist/${asset} missing"
  done
  ok "dist/main.js dist/manifest.json dist/restore.mjs all present"
else
  printf "  \033[33m⚠ dist/ not present — run scripts/release.sh before tagging\033[0m\n"
fi

step "Done"
printf "\n\033[1;32m✓ Submission audit clean — ready to tag + open Community PR\033[0m\n"
printf "Next:\n"
printf "  \033[1mgit tag -s v%s -m \"Archivist v%s\"\033[0m\n" "${MANIFEST_VERSION}" "${MANIFEST_VERSION}"
printf "  \033[1mgit push --tags\033[0m\n"
printf "  \033[1mgh release create v%s dist/* --notes-file CHANGELOG.md\033[0m\n" "${MANIFEST_VERSION}"
printf "  Open PR against \033[1mobsidianmd/obsidian-releases\033[0m adding Archivist to community-plugins.json.\n"
