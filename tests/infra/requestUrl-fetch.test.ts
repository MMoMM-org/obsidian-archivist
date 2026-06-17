// Adapter that backs the Dropbox SDK's `fetch` with Obsidian's `requestUrl`
// (src/infra/requestUrlFetch.ts). Covers the Response-like shape the SDK reads
// plus body conversion and the failure path (Constitution L1: network code
// paths need a happy AND a failure/denial case).

import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest';

import { requestUrl } from 'obsidian';
import { requestUrlFetch } from '../../src/infra/requestUrlFetch';

vi.mock('obsidian', () => ({
  requestUrl: vi.fn(),
}));

const mockRequestUrl = requestUrl as unknown as Mock;

function reply(overrides: Partial<{
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  json: unknown;
  text: string;
}>) {
  mockRequestUrl.mockResolvedValueOnce({
    status: 200,
    headers: {},
    arrayBuffer: new ArrayBuffer(0),
    json: null,
    text: '',
    ...overrides,
  });
}

beforeEach(() => {
  mockRequestUrl.mockReset();
});

describe('requestUrlFetch', () => {
  it('RPC happy path: surfaces text(), ok, and status', async () => {
    reply({ status: 200, text: '{"id":"abc"}' });

    const res = await requestUrlFetch('https://api.dropboxapi.com/2/files/get_metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"path":"/x"}',
    });

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"id":"abc"}');

    // throw:false so the SDK can build its own error from non-2xx bodies.
    expect(mockRequestUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://api.dropboxapi.com/2/files/get_metadata',
        method: 'POST',
        body: '{"path":"/x"}',
        throw: false,
      }),
    );
  });

  it('download path: blob() carries bytes; header lookup is case-insensitive', async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    reply({
      status: 200,
      // Server casing differs from what the SDK queries ('dropbox-api-result').
      headers: { 'Dropbox-API-Result': '{"name":"f.md"}' },
      arrayBuffer: payload.buffer,
    });

    const res = await requestUrlFetch('https://content.dropboxapi.com/2/files/download');

    expect(res.headers.get('dropbox-api-result')).toBe('{"name":"f.md"}');
    const blob = await res.blob();
    expect(blob.size).toBe(4);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(payload);
  });

  it('binary upload: a Uint8Array view reaches requestUrl as an exact ArrayBuffer', async () => {
    reply({ status: 200, text: '{}' });

    // A view with a non-zero byteOffset into a larger buffer.
    const backing = new Uint8Array([9, 9, 10, 20, 30, 9]);
    const view = backing.subarray(2, 5); // [10, 20, 30], byteOffset 2

    await requestUrlFetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: { 'Dropbox-API-Arg': '{}' },
      body: view,
    });

    const sentBody = mockRequestUrl.mock.calls[0][0].body as ArrayBuffer;
    expect(sentBody).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(sentBody)).toEqual(new Uint8Array([10, 20, 30]));
  });

  it('failure path: non-2xx surfaces ok=false and the status (no throw)', async () => {
    reply({ status: 409, text: '{"error_summary":"path/conflict"}' });

    const res = await requestUrlFetch('https://api.dropboxapi.com/2/files/upload', {
      method: 'POST',
      body: '{}',
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(409);
    expect(await res.text()).toBe('{"error_summary":"path/conflict"}');
  });
});
