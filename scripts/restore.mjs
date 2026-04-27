#!/usr/bin/env node
// scripts/restore.mjs — Standalone Restore CLI (T8.5 / PRD S6 / SDD ADR-19).
//
// Zero-dependency: only Node stdlib. Verified by CI grep to prevent
// accidental `import 'some-npm-pkg'` creeping in.
//
// Input: a local directory that mirrors Apps/Archivist/<VAULT_PREFIX>/ —
// the Dropbox Desktop app's selective-sync layout is the canonical source,
// but any directory with the same tree shape works. The CLI never
// authenticates to Dropbox.
//
// Usage:
//   node scripts/restore.mjs --input <dir> --list-snapshots
//   node scripts/restore.mjs --input <dir> --at <id|prefix|date|latest> --output <dir>
//   node scripts/restore.mjs --input <dir> --at <...> --output <dir> --dry-run
//   node scripts/restore.mjs --input <dir> --verify-only

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const opts = {
    input: null,
    output: null,
    at: null,
    listSnapshots: false,
    dryRun: false,
    verifyOnly: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--input':
        opts.input = argv[++i];
        break;
      case '--output':
        opts.output = argv[++i];
        break;
      case '--at':
        opts.at = argv[++i];
        break;
      case '--list-snapshots':
        opts.listSnapshots = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--verify-only':
        opts.verifyOnly = true;
        break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// JSON + hash helpers
// ---------------------------------------------------------------------------

async function readJson(path) {
  const text = await readFile(path, 'utf8');
  return JSON.parse(text);
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function contentPathFor(root, hash) {
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error(`INVALID_CONTENT_HASH: ${hash}`);
  }
  return join(root, 'content', hash.slice(0, 2), hash);
}

function manifestPathFor(root, id) {
  return join(root, 'snapshots', `${id}.json`);
}

// ---------------------------------------------------------------------------
// Index + manifest loaders
// ---------------------------------------------------------------------------

export async function loadIndex(root) {
  const path = join(root, 'snapshot_index.json');
  try {
    return await readJson(path);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function loadHead(root) {
  try {
    return await readJson(join(root, 'HEAD.json'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function loadManifest(root, id) {
  return readJson(manifestPathFor(root, id));
}

// ---------------------------------------------------------------------------
// Snapshot id resolution (partial / date / latest)
// ---------------------------------------------------------------------------

export function resolveSnapshotId(indexEntries, selector, headId) {
  if (!indexEntries || indexEntries.length === 0) {
    throw new Error('NO_SNAPSHOTS: snapshot_index has no entries');
  }

  const sorted = indexEntries
    .slice()
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));

  if (selector === 'latest' || selector === null || selector === undefined) {
    if (headId) return headId;
    // HEAD missing fallback — use the newest by created_at.
    return sorted[0].id;
  }

  // Exact id match
  const exact = indexEntries.find((e) => e.id === selector);
  if (exact) return exact.id;

  // Date-prefix match: YYYY-MM-DD — latest snapshot whose id starts with that.
  if (/^\d{4}-\d{2}-\d{2}$/.test(selector)) {
    const onDate = sorted.filter((e) => e.id.startsWith(selector));
    if (onDate.length === 0) {
      throw new Error(`NO_SNAPSHOT_ON_DATE: no snapshot matches ${selector}`);
    }
    return onDate[0].id;
  }

  // Substring / prefix match (partial id)
  const matches = indexEntries.filter((e) => e.id.includes(selector));
  if (matches.length === 1) return matches[0].id;
  if (matches.length === 0) {
    throw new Error(`UNKNOWN_SNAPSHOT: no match for "${selector}"`);
  }
  throw new Error(
    `AMBIGUOUS_SNAPSHOT: "${selector}" matches ${matches.length} snapshots (${matches
      .map((m) => m.id)
      .join(', ')})`,
  );
}

// ---------------------------------------------------------------------------
// Chain walk + state merge (mirrors RestoreService.materializeVaultStateAt)
// ---------------------------------------------------------------------------

export async function loadChainToFull(root, targetId) {
  const chain = [];
  const seen = new Set();
  let cursor = targetId;
  while (cursor) {
    if (seen.has(cursor)) {
      throw new Error(`CHAIN_BROKEN: cycle detected at ${cursor}`);
    }
    seen.add(cursor);
    let m;
    try {
      m = await loadManifest(root, cursor);
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error(`CHAIN_BROKEN: cannot reach Full ancestor from ${targetId} (missing ${cursor})`);
      }
      throw err;
    }
    chain.push(m);
    if (m.type === 'full') break;
    cursor = m.parent_id;
  }
  if (chain.length === 0 || chain[chain.length - 1].type !== 'full') {
    throw new Error(`CHAIN_BROKEN: cannot reach Full ancestor from ${targetId}`);
  }
  return chain;
}

export function mergeChain(chain) {
  // chain: newest→oldest ending in Full. Replay oldest→newest.
  const ordered = chain.slice().reverse();
  const state = { ...ordered[0].files };
  for (let i = 1; i < ordered.length; i++) {
    const m = ordered[i];
    for (const { from, to } of m.renames ?? []) {
      if (!state[from]) continue;
      if (state[to]) continue; // collision — skip (matches in-plugin behaviour)
      state[to] = state[from];
      delete state[from];
    }
    for (const [p, entry] of Object.entries(m.files ?? {})) state[p] = entry;
    for (const p of m.deleted ?? []) delete state[p];
  }
  return state;
}

export async function materializeState(root, targetId) {
  const chain = await loadChainToFull(root, targetId);
  return mergeChain(chain);
}

// ---------------------------------------------------------------------------
// Blob fetch + verify
// ---------------------------------------------------------------------------

export async function fetchBlob(root, hash) {
  const path = contentPathFor(root, hash);
  const bytes = await readFile(path);
  const actual = sha256Hex(bytes);
  if (actual !== hash) {
    throw new Error(`CONTENT_HASH_MISMATCH: ${path} (expected ${hash}, got ${actual})`);
  }
  return bytes;
}

export async function verifyBlob(root, hash) {
  const path = contentPathFor(root, hash);
  try {
    const bytes = await readFile(path);
    return { hash, path, ok: sha256Hex(bytes) === hash };
  } catch (err) {
    return { hash, path, ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Reconstruct (write state to output dir using atomic-dir pattern)
// ---------------------------------------------------------------------------

export async function reconstruct(root, state, outputDir, opts = {}) {
  const { dryRun = false, verifyOnly = false } = opts;

  const entries = Object.entries(state).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  if (verifyOnly) {
    const failures = [];
    for (const [p, entry] of entries) {
      const r = await verifyBlob(root, entry.hash);
      if (!r.ok) failures.push({ path: p, ...r });
    }
    return { verified: entries.length, failures };
  }

  if (dryRun) {
    const plan = entries.map(([p, entry]) => ({ path: p, size: entry.size, hash: entry.hash }));
    return { plan };
  }

  if (!outputDir) {
    throw new Error('MISSING_OUTPUT: --output is required unless --dry-run or --verify-only');
  }

  // Atomic-dir pattern: write to <output>.tmp then rename. If the tmp dir
  // already exists (from a prior aborted run), remove it first so this run
  // starts clean.
  const tmpDir = `${outputDir}.tmp`;
  try {
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });

    for (const [p, entry] of entries) {
      const bytes = await fetchBlob(root, entry.hash);
      const dest = join(tmpDir, p);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, bytes);
    }

    // Remove any stale outputDir (atomic-dir: last-write wins).
    await rm(outputDir, { recursive: true, force: true });
    await rename(tmpDir, outputDir);

    return { written: entries.length, outputDir };
  } catch (err) {
    // Clean up the tmp dir on any failure so partial output doesn't linger.
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      // swallow
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// list-snapshots
// ---------------------------------------------------------------------------

export async function listSnapshots(root) {
  const idx = await loadIndex(root);
  if (!idx) return [];
  return idx.snapshots
    .slice()
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
}

function formatSnapshotLine(s) {
  const parent = s.parent_id ?? '(root)';
  return `${s.id}  ${s.type.padEnd(4)}  parent=${parent}  ${s.created_at}`;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function main(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  let opts;
  try {
    opts = parseArgs(argv.slice(2));
  } catch (err) {
    io.stderr.write(`Error: ${err.message}\n`);
    return 2;
  }

  if (opts.help || (!opts.input && !opts.listSnapshots && !opts.at && !opts.verifyOnly)) {
    io.stdout.write(USAGE);
    return opts.help ? 0 : 2;
  }

  if (!opts.input) {
    io.stderr.write('Error: --input <dir> is required.\n');
    return 2;
  }

  // Sanity check: input must exist and be a directory.
  try {
    const s = await stat(opts.input);
    if (!s.isDirectory()) {
      io.stderr.write(`Error: --input is not a directory: ${opts.input}\n`);
      return 2;
    }
  } catch {
    io.stderr.write(`Error: --input directory not found: ${opts.input}\n`);
    return 2;
  }

  try {
    if (opts.listSnapshots) {
      const entries = await listSnapshots(opts.input);
      if (entries.length === 0) {
        io.stderr.write('No snapshots found.\n');
        return 1;
      }
      for (const s of entries) io.stdout.write(formatSnapshotLine(s) + '\n');
      return 0;
    }

    const indexDoc = await loadIndex(opts.input);
    const head = await loadHead(opts.input);
    const indexEntries = indexDoc?.snapshots ?? [];

    if (opts.verifyOnly) {
      // Resolve target — default to HEAD if no --at given.
      let targetId;
      try {
        targetId = resolveSnapshotId(indexEntries, opts.at ?? 'latest', head?.snapshot_id);
      } catch (err) {
        io.stderr.write(`Error: ${err.message}\n`);
        return 1;
      }
      const state = await materializeState(opts.input, targetId);
      const result = await reconstruct(opts.input, state, null, { verifyOnly: true });
      if (result.failures.length > 0) {
        for (const f of result.failures) {
          io.stderr.write(`VERIFY_FAIL ${f.path}: ${f.error ?? 'hash mismatch'}\n`);
        }
        return 1;
      }
      io.stdout.write(`Verified ${result.verified} files under snapshot ${targetId}.\n`);
      return 0;
    }

    // Reconstruct path
    let targetId;
    try {
      targetId = resolveSnapshotId(indexEntries, opts.at ?? 'latest', head?.snapshot_id);
    } catch (err) {
      io.stderr.write(`Error: ${err.message}\n`);
      return 1;
    }
    if (!head && indexEntries.length > 0) {
      io.stderr.write(`WARN: HEAD.json missing — using ${targetId}.\n`);
    }

    const state = await materializeState(opts.input, targetId);

    if (opts.dryRun) {
      const { plan } = await reconstruct(opts.input, state, null, { dryRun: true });
      io.stdout.write(`Would write ${plan.length} files from snapshot ${targetId}:\n`);
      for (const p of plan) {
        io.stdout.write(`  ${p.path}  ${p.size} bytes  ${p.hash.slice(0, 12)}…\n`);
      }
      return 0;
    }

    if (!opts.output) {
      io.stderr.write('Error: --output <dir> is required (or pass --dry-run).\n');
      return 2;
    }

    const result = await reconstruct(opts.input, state, opts.output, {});
    io.stdout.write(`Restored ${result.written} files to ${result.outputDir} (snapshot ${targetId}).\n`);
    return 0;
  } catch (err) {
    io.stderr.write(`Error: ${err.message}\n`);
    return 1;
  }
}

const USAGE = `Usage:
  node scripts/restore.mjs --input <dir> --list-snapshots
  node scripts/restore.mjs --input <dir> --at <id|prefix|YYYY-MM-DD|latest> --output <dir>
  node scripts/restore.mjs --input <dir> --at <...> --output <dir> --dry-run
  node scripts/restore.mjs --input <dir> --verify-only [--at <...>]

--input       Local directory mirroring Apps/Archivist/<VAULT_PREFIX>/.
--at          Snapshot selector. Accepts an exact id, a unique partial id,
              a YYYY-MM-DD date prefix, or 'latest' (default).
--output      Output directory. Written via atomic-dir (tmp → rename).
--list-snapshots  Print all snapshots newest-first.
--dry-run     Print the file plan without writing.
--verify-only Walk the chain, re-hash every content blob, exit non-zero
              on any mismatch.
`;

// Run if invoked as the entrypoint (not when imported for tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv).then((code) => process.exit(code));
}
