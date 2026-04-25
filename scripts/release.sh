#!/usr/bin/env bash
# Pre-release validation + artifact build (T10.5).
#
# Runs the full validation chain and produces release-ready artifacts in
# dist/. Fails fast on any check. Intended to be run from a clean working
# tree at a release tag.
#
# Outputs (in dist/):
#   - main.js
#   - manifest.json
#   - styles.css       (if styles.css exists at repo root)
#   - restore.mjs      (the standalone CLI — ships on every Release)
#
# Exit codes:
#   0  clean — artifacts ready for `gh release create`
#   1  validation failed
#   2  build failed
#   3  artifact size gate exceeded
#   4  styles.css contains hard-coded hex colors

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "${SCRIPT_DIR}/.." && pwd )"
cd "${REPO_ROOT}"

DIST_DIR="${REPO_ROOT}/dist"
MAX_MAIN_JS_BYTES=$((1 * 1024 * 1024))   # 1 MB

step() { printf "\n\033[1;34m▸ %s\033[0m\n" "$*"; }
ok()   { printf "\033[1;32m  ✓ %s\033[0m\n" "$*"; }
fail() { printf "\033[1;31m  ✗ %s\033[0m\n" "$*"; exit "${2:-1}"; }

step "Verifying clean working tree"
if [ -n "$(git status --porcelain)" ]; then
  fail "working tree has uncommitted changes — refusing to build a release" 1
fi
ok "clean"

step "Installing exact lockfile (npm ci)"
npm ci
ok "deps locked"

step "Type-checking"
npm run typecheck
ok "typecheck clean"

step "Linting"
npm run lint
ok "lint clean"

step "Running tests"
npm test
ok "tests pass"

step "Auditing dependencies (high/critical only)"
if ! npm audit --audit-level=high; then
  fail "npm audit found high/critical vulnerabilities — see above" 1
fi
ok "audit clean"

step "Building production bundle"
npm run build
[ -f main.js ] || fail "build did not produce main.js" 2
ok "build produced main.js"

step "Enforcing main.js size gate (≤ 1 MB)"
MAIN_BYTES=$(wc -c < main.js | tr -d ' ')
if [ "${MAIN_BYTES}" -gt "${MAX_MAIN_JS_BYTES}" ]; then
  fail "main.js is ${MAIN_BYTES} bytes — exceeds 1 MB ceiling" 3
fi
ok "main.js: ${MAIN_BYTES} bytes"

step "Pre-submission grep (no eval / innerHTML / undeclared hosts in main.js)"
if grep -nE 'eval[[:space:]]*\(' main.js; then
  fail "main.js contains eval() — blocked" 1
fi
if grep -nE '\.innerHTML[[:space:]]*=' main.js; then
  fail "main.js contains innerHTML assignment — blocked" 1
fi
# Declared hosts only — anything else means a smuggled fetch.
ALLOWED_HOSTS_RE='api\.dropboxapi\.com|content\.dropboxapi\.com|www\.dropbox\.com'
SMUGGLED=$(grep -oE '[a-z0-9-]+\.[a-z]+\.(com|org|io|net|app|dev)' main.js | grep -vE "${ALLOWED_HOSTS_RE}" | sort -u || true)
if [ -n "${SMUGGLED}" ]; then
  fail "main.js references undeclared hosts: ${SMUGGLED}" 1
fi
ok "no eval / no innerHTML / hosts allowlisted"

step "Verifying isDesktopOnly: true in manifest.json"
if ! grep -qE '"isDesktopOnly"[[:space:]]*:[[:space:]]*true' manifest.json; then
  fail "manifest.json missing isDesktopOnly: true" 1
fi
ok "isDesktopOnly enforced"

if [ -f styles.css ]; then
  step "styles.css uses CSS variables only (no hard-coded hex)"
  if grep -nE '#[0-9a-fA-F]{3,8}\b' styles.css; then
    fail "styles.css contains hard-coded hex colors — use Obsidian CSS vars" 4
  fi
  ok "styles.css: no hex"
fi

step "Assembling release artifacts in dist/"
rm -rf "${DIST_DIR}"
mkdir -p "${DIST_DIR}"
cp main.js "${DIST_DIR}/main.js"
cp manifest.json "${DIST_DIR}/manifest.json"
[ -f styles.css ] && cp styles.css "${DIST_DIR}/styles.css"
cp scripts/restore.mjs "${DIST_DIR}/restore.mjs"
ok "artifacts: $(ls "${DIST_DIR}" | tr '\n' ' ')"

step "Done"
printf "\n\033[1;32m✓ Release artifacts ready in dist/\033[0m\n"
printf "Next: \033[1mgh release create vX.Y.Z dist/* --notes-file CHANGELOG.md\033[0m\n"
