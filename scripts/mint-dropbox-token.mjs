#!/usr/bin/env node
// mint-dropbox-token.mjs — mint a Dropbox OAuth2 refresh token for development
// and CI, without touching the plugin's own credentials.
//
// Exists because ADR-21 moved plugin tokens into Obsidian's SecretStorage
// (Electron safeStorage, OS-keychain backed). They are encrypted at rest and
// deliberately unreadable from the repo, a container, or a CI runner — so the
// two consumers that need a token outside Obsidian have to mint their own:
//
//   * .github/workflows/live-dropbox.yml — needs the DROPBOX_TEST_REFRESH_TOKEN
//     repo secret, otherwise tests/live/smoke.test.ts self-skips and the job
//     reports a green no-op.
//   * scripts/dropbox-inspect.mjs — needs DROPBOX_REFRESH_TOKEN in the env.
//
// Zero npm deps, mirroring scripts/restore.mjs and scripts/dropbox-inspect.mjs.
//
// USAGE — two steps, both non-interactive (no TTY required, so this works from
// a Claude Code bash cell or any non-interactive shell):
//
//   node scripts/mint-dropbox-token.mjs url
//   node scripts/mint-dropbox-token.mjs exchange <verifier> <code> [--print]
//
// Step 1 prints an authorization URL plus the PKCE verifier that belongs to it.
// Open the URL in a PRIVATE browser window and log in with the account the
// token should belong to (a dedicated test account is preferable to the
// production one). Dropbox displays an access code.
//
// Step 2 exchanges that code. By default the refresh token is piped straight
// into `gh secret set DROPBOX_TEST_REFRESH_TOKEN` via stdin, so it is never
// printed and never lands in a transcript or shell history. Pass --print to
// write it to stdout instead, for local use with dropbox-inspect.
//
// The verifier and the code are safe to have in a transcript: the code is
// single-use and consumed by step 2, and the verifier alone proves nothing.
//
// EXIT CODES:
//   0  ok
//   1  usage error / no refresh token in the response
//   2  Dropbox token exchange failed (status + body printed)

import process from 'node:process';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

// Same public PKCE client id the plugin ships (src/config/dropbox.ts). PKCE
// client ids are not secret — they travel in the authorization URL.
const DEFAULT_CLIENT_ID = 'aanoqah5sn73rjb';
const AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';

// Must match OAUTH_SCOPE in src/config/dropbox.ts — the live smoke test calls
// uploadBlob / downloadBytes / deleteV2 / listFolder, and dropbox-inspect reads
// metadata. A narrower grant makes those fail at call time, not at mint time.
const SCOPE =
  'files.content.write files.content.read files.metadata.read account_info.read';

const SECRET_NAME = 'DROPBOX_TEST_REFRESH_TOKEN';
const VERIFIER_BYTES = 32;

const clientId = process.env.DROPBOX_CLIENT_ID || DEFAULT_CLIENT_ID;
const self = 'scripts/mint-dropbox-token.mjs';

function b64url(buf) {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fail(message, code = 1) {
  console.error(`error: ${message}`);
  process.exit(code);
}

function usage() {
  console.error(`usage: node ${self} url`);
  console.error(`       node ${self} exchange <verifier> <code> [--print]`);
  process.exit(1);
}

function printAuthorizeUrl() {
  const verifier = b64url(randomBytes(VERIFIER_BYTES));
  const challenge = b64url(createHash('sha256').update(verifier).digest());

  // redirect_uri is deliberately OMITTED. The plugin registers
  // obsidian://archivist-oauth; reusing it here would make the OS hand the
  // authorization code to the local Obsidian install, and Archivist would
  // overwrite its stored production tokens with this throwaway grant. With no
  // redirect_uri, Dropbox shows the code on screen instead.
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    token_access_type: 'offline', // without this there is no refresh_token
    scope: SCOPE,
  });

  console.log('1) Open in a PRIVATE browser window, log in as the token owner:\n');
  console.log(`   ${AUTHORIZE_URL}?${params.toString()}\n`);
  console.log('2) Dropbox shows an access code. Then run:\n');
  console.log(`   node ${self} exchange ${verifier} <code>\n`);
  console.log(`   Add --print to print the token instead of writing it into`);
  console.log(`   the ${SECRET_NAME} repo secret.\n`);
}

async function exchangeCode(verifier, code, printToStdout) {
  const body = new URLSearchParams({
    code,
    grant_type: 'authorization_code',
    code_verifier: verifier,
    client_id: clientId,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await res.text();
  if (res.ok === false) {
    fail(`token exchange failed: ${res.status} ${text}`, 2);
  }

  const json = JSON.parse(text);
  const refreshToken = json.refresh_token || '';
  if (refreshToken === '') {
    fail(
      `no refresh_token in the response (keys: ${Object.keys(json).join(', ')}) — ` +
        `the authorize URL must carry token_access_type=offline, re-run the url step`,
    );
  }

  const account = json.account_id || 'unknown';
  if (printToStdout) {
    console.error(`refresh token for ${account}:`);
    console.log(refreshToken);
    return;
  }

  console.error(
    `refresh token received for ${account} (${refreshToken.length} chars) — ` +
      `writing it into the ${SECRET_NAME} repo secret`,
  );
  await writeGithubSecret(refreshToken);
}

function writeGithubSecret(refreshToken) {
  return new Promise((resolvePromise) => {
    const gh = spawn('gh', ['secret', 'set', SECRET_NAME], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    gh.on('error', (e) => fail(`could not run gh: ${e.message}`, 2));
    gh.stdin.write(refreshToken);
    gh.stdin.end();
    gh.on('close', (exitCode) => {
      if (exitCode === 0) {
        console.error(`${SECRET_NAME} set — the token was never printed`);
        resolvePromise();
        return;
      }
      fail(`gh secret set exited with ${exitCode}`, 2);
    });
  });
}

const cmd = process.argv[2] || '';

if (cmd === 'url') {
  printAuthorizeUrl();
} else if (cmd === 'exchange') {
  const args = process.argv.slice(3);
  const printToStdout = args.includes('--print');
  const positional = args.filter((a) => a.startsWith('--') === false);
  const [verifier, code] = positional;
  if (verifier === undefined || code === undefined) usage();
  await exchangeCode(verifier, code, printToStdout);
} else {
  usage();
}
