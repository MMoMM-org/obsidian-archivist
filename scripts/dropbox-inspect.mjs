#!/usr/bin/env node
// dropbox-inspect.mjs — read-only inspection of an Archivist app-folder.
//
// Lives outside the bundled plugin: a Node CLI for verifying remote state
// during development (Phase 10 onward). Zero npm deps, mirrors the precedent
// set by scripts/restore.mjs.
//
// AUTH — set DROPBOX_REFRESH_TOKEN. Since ADR-21 the plugin keeps its tokens in
// Obsidian's SecretStorage (Electron safeStorage, OS-keychain backed), so a
// current install has no tokens.json for this script to read and no practical
// way for a CLI to decrypt the real one. Mint a throwaway token instead:
//
//   node scripts/mint-dropbox-token.mjs url
//   node scripts/mint-dropbox-token.mjs exchange <verifier> <code> --print
//
//   DROPBOX_REFRESH_TOKEN=<rt>           — primary auth path
//   DROPBOX_ACCESS_TOKEN=<at>            — bypass the refresh exchange
//   ARCHIVIST_TOKENS_PATH=<file>         — legacy tokens.json (ADR-7 vaults)
//   DROPBOX_CLIENT_ID=<id>               — override CLIENT_ID (defaults: prod)
//
// LEGACY FALLBACK — a pre-0.8.0 (ADR-7) test vault may still carry
//   test/Archivist/.obsidian/plugins/obsidian-archivist/tokens.json
// which is read when neither env var is set. A still-valid access_token is used
// directly; otherwise its refresh_token is exchanged for a fresh one. Vaults
// migrated by LegacyTokenMigration no longer have the file.
//
// VAULT — auto-read from data.json (settings.advanced.vault_prefix). Note the
// plugin leaves that field EMPTY until the user sets one explicitly and derives
// the prefix from the vault name at runtime instead (main.ts: `vault_prefix ||
// slugifyVaultName(name)`). This script does not replicate that slugify — pass
// the prefix explicitly when the setting is blank. Override:
//   ARCHIVIST_VAULT_PREFIX=<prefix>      — explicit prefix
//   ARCHIVIST_DATA_PATH=<file>           — point at a different data.json
//   <prefix> as a positional arg also works
//
// SUBCOMMANDS:
//   tree                       — recursive listing under Apps/Archivist/<prefix>
//   stats                      — counts + bytes per top-level category
//   head                       — print HEAD.json + snapshot_index summary
//   chain [<snapshot_id>]      — walk parent_id lineage (default: HEAD.latest)
//   cat <remote_path>          — print a small JSON file (no size guard)
//
// EXAMPLES:
//   DROPBOX_REFRESH_TOKEN=… node scripts/dropbox-inspect.mjs tree my-vault
//   DROPBOX_REFRESH_TOKEN=… node scripts/dropbox-inspect.mjs chain my-vault
//
// EXIT CODES:
//   0  success
//   1  usage / missing env / argument error
//   2  Dropbox API error (status + body printed)
//   3  remote object not found

import process from 'node:process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_CLIENT_ID = 'aanoqah5sn73rjb';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const API = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';

// Plugin paths are app-folder-relative — Dropbox auto-prepends /Apps/Archivist/
// server-side because the OAuth app is App-Folder scoped. The script accesses
// the same scope via the user's tokens, so it must use the same form.
const APP_FOLDER_ROOT = '';

// Local test-vault paths — the script lives in scripts/, so resolve relative
// to the repo root (one level up) and let env vars override.
const REPO_ROOT = resolve(new URL('.', import.meta.url).pathname, '..');
const DEFAULT_TOKENS_PATH = resolve(
  REPO_ROOT,
  'test/Archivist/.obsidian/plugins/obsidian-archivist/tokens.json',
);
const DEFAULT_DATA_PATH = resolve(
  REPO_ROOT,
  'test/Archivist/.obsidian/plugins/obsidian-archivist/data.json',
);

// Refresh proactively when the token is within this window of expiry. Mirrors
// TokenStore's safety margin (60s) so the script and the plugin agree on
// "near expiry" semantics.
const NEAR_EXPIRY_MS = 60_000;

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

function readJsonIfPresent(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    fail(`failed to parse ${path}: ${e.message}`);
  }
}

function loadVaultTokens() {
  const path = process.env.ARCHIVIST_TOKENS_PATH || DEFAULT_TOKENS_PATH;
  const t = readJsonIfPresent(path);
  if (!t) return null;
  if (typeof t.refresh_token !== 'string' || typeof t.access_token !== 'string') {
    fail(`tokens.json at ${path} missing required fields`);
  }
  return { ...t, _path: path };
}

async function refreshAccessToken(refreshToken) {
  const clientId = process.env.DROPBOX_CLIENT_ID || DEFAULT_CLIENT_ID;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    fail(`token refresh failed: ${res.status} ${await res.text()}`, 2);
  }
  const json = await res.json();
  return json.access_token;
}

async function obtainAccessToken() {
  // 1. explicit access token wins (ad-hoc 4 h tokens from the app console)
  if (process.env.DROPBOX_ACCESS_TOKEN) return process.env.DROPBOX_ACCESS_TOKEN;

  // 2. explicit refresh token bypasses tokens.json
  if (process.env.DROPBOX_REFRESH_TOKEN) {
    return refreshAccessToken(process.env.DROPBOX_REFRESH_TOKEN);
  }

  // 3. legacy: auto-read from a pre-ADR-21 test vault's tokens.json
  const t = loadVaultTokens();
  if (!t) {
    fail(
      `no tokens — set DROPBOX_REFRESH_TOKEN or DROPBOX_ACCESS_TOKEN. Since ` +
        `ADR-21 the plugin stores its tokens in Obsidian SecretStorage, not in ` +
        `tokens.json, so completing the in-app OAuth flow no longer leaves a ` +
        `file here for auto-discovery. Mint a token for CLI use with: ` +
        `node scripts/mint-dropbox-token.mjs url ` +
        `(looked at ${process.env.ARCHIVIST_TOKENS_PATH || DEFAULT_TOKENS_PATH})`,
    );
  }
  const expiresAt = Date.parse(t.access_token_expires_at);
  if (Number.isFinite(expiresAt) && expiresAt - Date.now() > NEAR_EXPIRY_MS) {
    return t.access_token; // still fresh
  }
  return refreshAccessToken(t.refresh_token);
}

function resolveVaultPrefix(positional) {
  if (positional) return positional;
  if (process.env.ARCHIVIST_VAULT_PREFIX) return process.env.ARCHIVIST_VAULT_PREFIX;
  const path = process.env.ARCHIVIST_DATA_PATH || DEFAULT_DATA_PATH;
  const data = readJsonIfPresent(path);
  // settings.advanced.vault_prefix — NOT settings.vault_prefix. The field has
  // always lived under AdvancedSettings (src/model/Settings.ts); reading it one
  // level too shallow made this auto-read silently return undefined every time.
  const prefix = data?.settings?.advanced?.vault_prefix;
  if (typeof prefix === 'string' && prefix.length > 0) return prefix;
  return null;
}

// ---------------------------------------------------------------------------
// dropbox api helpers
// ---------------------------------------------------------------------------

async function rpc(token, endpoint, payload) {
  const res = await fetch(`${API}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 409 && text.includes('not_found')) {
      const err = new Error(`not_found: ${JSON.stringify(payload)}`);
      err.notFound = true;
      throw err;
    }
    throw new Error(`Dropbox ${endpoint} ${res.status}: ${text}`);
  }
  return res.json();
}

async function downloadFile(token, path) {
  const res = await fetch(`${CONTENT}/files/download`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Dropbox-API-Arg': JSON.stringify({ path: `/${path.replace(/^\/+/, '')}` }),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 409 && text.includes('not_found')) {
      const err = new Error(`not_found: ${path}`);
      err.notFound = true;
      throw err;
    }
    throw new Error(`Dropbox download ${path} ${res.status}: ${text}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function listFolderAll(token, path, recursive = false) {
  const all = [];
  let cursor = null;
  while (true) {
    const payload = cursor
      ? { cursor }
      : { path: `/${path.replace(/^\/+/, '')}`, recursive, include_deleted: false };
    const endpoint = cursor ? '/files/list_folder/continue' : '/files/list_folder';
    const res = await rpc(token, endpoint, payload);
    all.push(...res.entries);
    if (!res.has_more) break;
    cursor = res.cursor;
  }
  return all;
}

// ---------------------------------------------------------------------------
// subcommands
// ---------------------------------------------------------------------------

function vaultRoot(prefix) {
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(prefix)) {
    fail(`invalid vault prefix: ${prefix}`);
  }
  return `${APP_FOLDER_ROOT}/${prefix}`;
}

async function cmdTree(token, prefix) {
  const root = vaultRoot(prefix);
  const entries = await listFolderAll(token, root, true).catch((e) => {
    if (e.notFound) {
      console.log(`(empty — ${root} does not exist yet)`);
      process.exit(0);
    }
    throw e;
  });
  entries.sort((a, b) => a.path_display.localeCompare(b.path_display));
  for (const e of entries) {
    const rel = e.path_display.slice(`/${root}`.length).replace(/^\/+/, '') || '/';
    if (e['.tag'] === 'folder') {
      console.log(`d  ${rel}/`);
    } else {
      console.log(`f  ${rel.padEnd(60)} ${formatBytes(e.size).padStart(10)}  ${e.server_modified}`);
    }
  }
}

async function cmdStats(token, prefix) {
  const root = vaultRoot(prefix);
  const entries = await listFolderAll(token, root, true).catch((e) => {
    if (e.notFound) {
      console.log(`(empty — ${root} does not exist yet)`);
      process.exit(0);
    }
    throw e;
  });
  const buckets = new Map();
  for (const e of entries) {
    if (e['.tag'] !== 'file') continue;
    const rel = e.path_display.slice(`/${root}`.length).replace(/^\/+/, '');
    const top = rel.split('/')[0] || '<root>';
    const b = buckets.get(top) || { count: 0, bytes: 0 };
    b.count += 1;
    b.bytes += e.size;
    buckets.set(top, b);
  }
  console.log(`vault root: ${root}`);
  console.log('');
  let totalC = 0, totalB = 0;
  for (const [top, b] of [...buckets.entries()].sort()) {
    console.log(`  ${top.padEnd(20)} ${String(b.count).padStart(6)} files  ${formatBytes(b.bytes).padStart(10)}`);
    totalC += b.count;
    totalB += b.bytes;
  }
  console.log('  ' + '-'.repeat(48));
  console.log(`  ${'TOTAL'.padEnd(20)} ${String(totalC).padStart(6)} files  ${formatBytes(totalB).padStart(10)}`);
}

/**
 * Download snapshot_index.json and return a Map of id -> entry, or null when
 * the file is absent. `tier` lives here (SnapshotIndexEntry, populated during
 * retention runs) and NOT on the snapshot manifest, so any caller that wants
 * to show a tier has to join against this.
 */
async function loadSnapshotIndex(token, root) {
  const bytes = await downloadFile(token, `${root}/snapshot_index.json`).catch(() => null);
  if (!bytes) return null;
  const idx = JSON.parse(bytes.toString('utf8'));
  const entries = Array.isArray(idx.snapshots) ? idx.snapshots : [];
  return new Map(entries.map((e) => [e.id, e]));
}

async function cmdHead(token, prefix) {
  const root = vaultRoot(prefix);
  const headBytes = await downloadFile(token, `${root}/HEAD.json`).catch((e) => {
    if (e.notFound) {
      console.log('(no HEAD.json — vault not initialized)');
      process.exit(3);
    }
    throw e;
  });
  const head = JSON.parse(headBytes.toString('utf8'));
  console.log('HEAD.json:');
  console.log(JSON.stringify(head, null, 2));

  const index = await loadSnapshotIndex(token, root);
  if (index === null) {
    console.log('\n(no snapshot_index.json)');
    return;
  }
  const entries = [...index.values()];
  console.log(`\nsnapshot_index.json — ${entries.length} entries`);
  for (const e of entries.slice(-10)) {
    console.log(`  ${e.id}  ${e.parent_id ? '← ' + e.parent_id : '(root)'}`);
  }
  if (entries.length > 10) console.log(`  … (${entries.length - 10} earlier)`);
}

/**
 * Render the retention tier for `id`. Three distinguishable outcomes, because
 * they mean different things: no index at all, indexed but not yet evaluated
 * by a retention run (legitimate), and present in the chain but absent from
 * the index (a real inconsistency worth seeing).
 */
function describeTier(index, id) {
  if (index === null) return '(no index)';
  const entry = index.get(id);
  if (entry === undefined) return '(not indexed)';
  return entry.tier ?? '(unevaluated)';
}

async function cmdChain(token, prefix, startId) {
  const root = vaultRoot(prefix);
  let id = startId;
  if (!id) {
    const headBytes = await downloadFile(token, `${root}/HEAD.json`).catch((e) => {
      if (e.notFound) fail(`no HEAD.json — pass a snapshot id explicitly`, 3);
      throw e;
    });
    const head = JSON.parse(headBytes.toString('utf8'));
    // HEAD.json is { schema_version, snapshot_id, snapshot_type, device_id,
    // committed_at }. Earlier revisions of this script also probed `latest`
    // and `id`; neither has ever existed in the 1.0 schema.
    id = head.snapshot_id;
    if (!id) fail('HEAD.json has no snapshot_id');
  }

  // Joined for the tier column only — a missing index is not fatal.
  const index = await loadSnapshotIndex(token, root);

  const seen = new Set();
  let depth = 0;
  while (id) {
    if (seen.has(id)) {
      console.log(`  ⚠ cycle detected at ${id}`);
      break;
    }
    seen.add(id);
    const path = `${root}/snapshots/${id}.json`;
    const bytes = await downloadFile(token, path).catch((e) => {
      if (e.notFound) {
        console.log(`  ✗ ${id}  (manifest missing — broken chain)`);
        return null;
      }
      throw e;
    });
    if (!bytes) break;
    const m = JSON.parse(bytes.toString('utf8'));
    // manifest.files is Record<path, FileEntry> — an object, not an array.
    // `.length` on it is undefined, and a `|| []` guard never fires because
    // the object is truthy.
    const fileCount = Object.keys(m.files ?? {}).length;
    const tier = describeTier(index, id);
    console.log(
      `  ${'  '.repeat(depth)}${id}  type=${m.type || '?'}  tier=${tier}  files=${fileCount}  parent=${m.parent_id || '(root)'}`
    );
    id = m.parent_id;
    depth = Math.min(depth + 1, 10);
  }
  console.log(`\n  ${seen.size} snapshots in chain`);
}

async function cmdCat(token, _prefix, path) {
  if (!path) fail('cat requires a remote path');
  if (!path.startsWith(APP_FOLDER_ROOT)) {
    fail(`cat path must start with ${APP_FOLDER_ROOT}/ (got: ${path})`);
  }
  const bytes = await downloadFile(token, path).catch((e) => {
    if (e.notFound) fail(`not found: ${path}`, 3);
    throw e;
  });
  process.stdout.write(bytes);
}

// ---------------------------------------------------------------------------
// utilities
// ---------------------------------------------------------------------------

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fail(msg, code = 1) {
  console.error(`error: ${msg}`);
  process.exit(code);
}

function usage() {
  console.error(`usage: node scripts/dropbox-inspect.mjs <command> [<vault_prefix>] [args]

commands:
  tree   [<prefix>]            recursive listing
  stats  [<prefix>]            counts + bytes per top-level dir
  head   [<prefix>]            HEAD.json + snapshot_index summary
  chain  [<prefix>] [<id>]     walk parent lineage (default: HEAD.latest)
  cat    [<prefix>] <path>     print a remote file (path under Apps/Archivist/)

Auth comes from DROPBOX_REFRESH_TOKEN — since ADR-21 the plugin keeps its
tokens in Obsidian SecretStorage, so there is no tokens.json to auto-discover
on a current install. Mint one for CLI use:
  node scripts/mint-dropbox-token.mjs url
The vault prefix is auto-read from the test vault's data.json, but only when
settings.advanced.vault_prefix is set explicitly — otherwise pass it in.

overrides (env):
  DROPBOX_ACCESS_TOKEN     skip everything, use this short-lived token
  DROPBOX_REFRESH_TOKEN    primary auth path, refresh with this token
  ARCHIVIST_TOKENS_PATH    legacy tokens.json (pre-0.8.0 vaults only)
  ARCHIVIST_DATA_PATH      point at a different data.json
  ARCHIVIST_VAULT_PREFIX   bypass settings.vault_prefix from data.json
  DROPBOX_CLIENT_ID        defaults to ${DEFAULT_CLIENT_ID}
`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === '-h' || cmd === '--help') usage();

  const token = await obtainAccessToken();

  // cat takes a full remote path and no prefix; everything else needs prefix.
  if (cmd === 'cat') {
    const path = rest.find((a) => typeof a === 'string' && a.includes('/'));
    await cmdCat(token, null, path);
    return;
  }

  // For non-cat commands, accept the prefix positionally only if it looks like
  // a valid prefix; otherwise fall through to env / data.json autodiscovery.
  const positional = /^[a-z0-9][a-z0-9_-]{1,63}$/.test(rest[0] ?? '') ? rest[0] : undefined;
  const prefix = resolveVaultPrefix(positional);
  if (!prefix) {
    fail(
      'no vault prefix — pass it positionally or set ARCHIVIST_VAULT_PREFIX. ' +
        'Auto-read only works when settings.advanced.vault_prefix is set explicitly; ' +
        'when it is blank the plugin derives the prefix from the vault name at ' +
        'runtime and there is nothing in data.json to read',
    );
  }

  switch (cmd) {
    case 'tree':
      await cmdTree(token, prefix);
      break;
    case 'stats':
      await cmdStats(token, prefix);
      break;
    case 'head':
      await cmdHead(token, prefix);
      break;
    case 'chain': {
      const startId = positional ? rest[1] : rest[0];
      await cmdChain(token, prefix, startId);
      break;
    }
    default:
      usage();
  }
}

main().catch((e) => {
  console.error(`error: ${e.message || e}`);
  process.exit(2);
});
