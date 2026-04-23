import { describe, it, expect } from 'vitest';
import { sha256hex } from '../../src/infra/Hasher';

describe('Hasher — sha256hex', () => {
  it('matches the canonical vector for the empty string', async () => {
    const hash = await sha256hex(new Uint8Array());
    expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('matches the canonical vector for "abc"', async () => {
    const hash = await sha256hex(new TextEncoder().encode('abc'));
    expect(hash).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('accepts raw ArrayBuffer input', async () => {
    const buf = new TextEncoder().encode('abc').buffer;
    const hash = await sha256hex(buf);
    expect(hash).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hashes a 2 MB buffer and returns a 64-char hex string', async () => {
    const buf = new Uint8Array(2 * 1024 * 1024);
    for (let i = 0; i < buf.length; i++) buf[i] = i & 0xff;
    const hash = await sha256hex(buf);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // same input produces same hash — light sanity on determinism
    expect(await sha256hex(buf)).toBe(hash);
  });

  it('rejects non-binary input with TypeError', async () => {
    // @ts-expect-error — testing runtime guard
    await expect(sha256hex('hello world')).rejects.toBeInstanceOf(TypeError);
    // @ts-expect-error — testing runtime guard
    await expect(sha256hex(null)).rejects.toBeInstanceOf(TypeError);
  });
});
