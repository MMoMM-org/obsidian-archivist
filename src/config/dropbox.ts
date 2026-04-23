// Dropbox OAuth app — Archivist (MiYo) — created 2026-04-23.
// PKCE client IDs are not secret; transmitted in the authorization URL.
// Do NOT reuse the predecessor plugin's CLIENT_ID (40ig42vaqj3762d).

export const DROPBOX_CLIENT_ID = 'aanoqah5sn73rjb';
export const DROPBOX_AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
export const DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
export const DROPBOX_REVOKE_URL = 'https://api.dropboxapi.com/2/auth/token/revoke';
export const OAUTH_REDIRECT_URI = 'obsidian://archivist-oauth';
// Dropbox expects space-separated scopes as a single string. Covers upload,
// download, list, and account_info (needed for dropbox_account_email later).
export const OAUTH_SCOPE =
  'files.content.write files.content.read files.metadata.read files.metadata.write account_info.read';
