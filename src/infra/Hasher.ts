// WebCrypto SHA-256 — ADR-10 (cross-platform: desktop Electron + future mobile).
// No Node-crypto fallback: crypto.subtle is available globally on Node ≥ 18 and
// in Obsidian's Electron renderer, which are the only runtimes we support.

function toArrayBuffer(input: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (input instanceof Uint8Array) {
    // Copy into a fresh ArrayBuffer so SharedArrayBuffer-backed Uint8Arrays
    // don't trip crypto.subtle.digest's type check.
    const out = new ArrayBuffer(input.byteLength);
    new Uint8Array(out).set(input);
    return out;
  }
  if (input instanceof ArrayBuffer) return input;
  throw new TypeError('sha256hex: expected ArrayBuffer or Uint8Array');
}

export async function sha256hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = toArrayBuffer(bytes);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const view = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < view.length; i++) {
    const h = view[i].toString(16);
    out += h.length === 1 ? '0' + h : h;
  }
  return out;
}
