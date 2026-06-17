import { requestUrl, type RequestUrlResponse } from 'obsidian';

// Why this exists: the `dropbox` SDK defaults to the global browser `fetch`,
// which in Obsidian's Electron renderer is subject to CORS. Dropbox's content
// API (`content.dropboxapi.com`) intermittently returns responses without an
// `Access-Control-Allow-Origin` header, so the browser blocks reading them
// (`net::ERR_FAILED 200 (OK)`). Obsidian's `requestUrl` is the sanctioned
// network primitive for community plugins — it routes through Electron's net
// stack and bypasses CORS entirely (same reason OAuthConnectFlow uses it).
//
// Passing this adapter as the SDK's `fetch` option fixes every Dropbox call —
// uploads, downloads, RPC, and (because `new Dropbox(options)` forwards
// `options.fetch` into its internal `DropboxAuth`) OAuth token refresh too.
//
// The returned object is a minimal `Response`-like shape covering exactly what
// the SDK consumes (see node_modules/dropbox/cjs/src/response.js):
//   - parseResponse (RPC + upload): `ok`, `status`, `headers`, `text()`
//   - parseDownloadResponse: `ok`, `status`, `headers.get('dropbox-api-result')`,
//     and `blob()` (the renderer is `isWindowOrWorker() === true`).

/** Init shape the SDK passes to its `fetch`; only the fields it sets. */
interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer | Uint8Array;
}

/** Minimal subset of the DOM `Response` interface the Dropbox SDK reads. */
interface ResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
  blob(): Promise<Blob>;
}

/**
 * `requestUrl` accepts `string | ArrayBuffer`. RPC bodies are JSON strings and
 * pass through; binary upload bodies arrive as `Uint8Array` (possibly a view
 * into a larger buffer) and must be sliced to their exact backing bytes.
 */
function toRequestBody(body: FetchInit['body']): string | ArrayBuffer | undefined {
  if (body === undefined || typeof body === 'string' || body instanceof ArrayBuffer) {
    return body;
  }
  // Uint8Array (possibly a view into a larger/shared buffer): copy out exactly
  // the viewed range into a fresh standalone ArrayBuffer.
  return new Uint8Array(body).buffer;
}

/**
 * Case-insensitive header lookup over `requestUrl`'s plain-object headers.
 * The SDK reads `dropbox-api-result`; Obsidian does not guarantee header casing.
 */
function headerGetter(headers: Record<string, string>): (name: string) => string | null {
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    lower[key.toLowerCase()] = value;
  }
  return (name: string): string | null => lower[name.toLowerCase()] ?? null;
}

function wrapResponse(resp: RequestUrlResponse): ResponseLike {
  return {
    ok: resp.status >= 200 && resp.status < 300,
    status: resp.status,
    headers: { get: headerGetter(resp.headers ?? {}) },
    text: (): Promise<string> => Promise.resolve(resp.text),
    json: (): Promise<unknown> =>
      Promise.resolve(
        resp.json !== null && resp.json !== undefined ? resp.json : JSON.parse(resp.text),
      ),
    arrayBuffer: (): Promise<ArrayBuffer> => Promise.resolve(resp.arrayBuffer),
    blob: (): Promise<Blob> => Promise.resolve(new Blob([resp.arrayBuffer])),
  };
}

/**
 * A `fetch`-compatible function backed by Obsidian's `requestUrl`. Pass as the
 * `fetch` option to the Dropbox SDK constructor. `throw: false` lets non-2xx
 * bodies flow back so the SDK can build its own `DropboxResponseError`.
 */
export async function requestUrlFetch(url: string, init: FetchInit = {}): Promise<ResponseLike> {
  const resp = await requestUrl({
    url,
    method: init.method ?? 'GET',
    headers: init.headers,
    body: toRequestBody(init.body),
    throw: false,
  });
  return wrapResponse(resp);
}
