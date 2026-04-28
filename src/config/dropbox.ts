// Dropbox OAuth app — Archivist (MiYo) — created 2026-04-23.
// PKCE client IDs are not secret; transmitted in the authorization URL.
// Do NOT reuse the predecessor plugin's CLIENT_ID (40ig42vaqj3762d).

export const DROPBOX_CLIENT_ID = 'aanoqah5sn73rjb';
export const DROPBOX_AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
export const DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
export const DROPBOX_REVOKE_URL = 'https://api.dropboxapi.com/2/auth/token/revoke';
export const DROPBOX_USERS_GET_CURRENT_ACCOUNT_URL =
  'https://api.dropboxapi.com/2/users/get_current_account';
export const OAUTH_REDIRECT_URI = 'obsidian://archivist-oauth';
// Dropbox expects space-separated scopes as a single string. Four scopes:
//   files.content.write — uploadBlob / uploadJson / uploadLarge / deleteV2
//   files.content.read  — downloadBytes / downloadJson
//   files.metadata.read — listFolder (orphan-blob detection in GC)
//   account_info.read   — fetch dropbox_account_email for the Settings UI
//
// `files.metadata.write` is NOT requested — we never call filesMove,
// filesCopyV2, or filesCreateFolderV2. Keeping the scope list to the
// minimum surface narrows the OAuth consent screen ("view information
// about" instead of "view AND edit information about").
export const OAUTH_SCOPE =
  'files.content.write files.content.read files.metadata.read account_info.read';
