// VaultIdentity — fingerprint + adoption flow.
//
// Test scenarios:
//   1. ensureLocalVaultId on a fresh vault generates and persists a UUID.
//   2. ensureLocalVaultId on a populated vault is a no-op (idempotent).
//   3. checkConsistency, both sides absent → 'fresh-folder' AND a local
//      UUID is generated as a side effect (so the next backup can claim).
//   4. checkConsistency, local set, remote missing → 'fresh-folder'.
//   5. checkConsistency, local missing, remote present → 'adopt-remote'.
//   6. checkConsistency, both set and matching → 'ok'.
//   7. checkConsistency, both set and mismatch → 'mismatch'.
//   8. checkConsistency, remote schema invalid → 'remote-corrupt'.
//   9. claimRemote uploads vault_meta with the local id + timestamp.
//   10. adoptVaultId overwrites the local id (used by the modal confirm).

import { describe, expect, it, vi } from 'vitest';
import { VaultIdentity } from '../../src/services/VaultIdentity';
import { PathError } from '../../src/model/Errors';
import { vaultMetaPath } from '../../src/util/paths';
import {
  CURRENT_VAULT_META_SCHEMA,
  type VaultMeta,
} from '../../src/model/VaultMeta';

const VAULT_PREFIX = 'test-vault';
const VAULT_NAME = 'TestVault';
const NOW = new Date('2026-04-28T10:00:00.000Z');

const VALID_UUID_A = '3f2a8c1e-7d4b-4f12-a1c0-bc5d76e9a2e1';
const VALID_UUID_B = '7c1e9b22-4a3f-4d18-bf3a-1d8e76e9a2e1';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeFakePluginStore(initialVaultId: string | null = null) {
  let vaultId = initialVaultId;
  return {
    loadVaultId: vi.fn(async (): Promise<string | null> => vaultId),
    saveVaultId: vi.fn(async (id: string): Promise<void> => {
      vaultId = id;
    }),
    get currentVaultId() { return vaultId; },
  };
}

function makeFakeDropbox() {
  const store = new Map<string, unknown>();
  const failingPaths = new Set<string>();
  return {
    store,
    failingPaths,
    uploadJson: vi.fn(async (path: string, value: unknown) => {
      store.set(path, JSON.parse(JSON.stringify(value)));
    }),
    downloadJson: vi.fn(async (path: string) => {
      if (failingPaths.has(path)) throw new Error('boom');
      if (!store.has(path)) throw new PathError('PATH_NOT_FOUND', `not found: ${path}`, false);
      return store.get(path);
    }),
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeVaultMeta(vaultId: string, name = VAULT_NAME): VaultMeta {
  return {
    schema_version: CURRENT_VAULT_META_SCHEMA,
    vault_id: vaultId,
    vault_name: name,
    claimed_at: '2026-04-20T08:00:00.000Z',
  };
}

function makeVaultIdentity(opts?: {
  initialLocalId?: string | null;
  remoteAt?: VaultMeta | null;
  generateId?: () => string;
}): {
  vi: VaultIdentity;
  store: ReturnType<typeof makeFakePluginStore>;
  dropbox: ReturnType<typeof makeFakeDropbox>;
} {
  const store = makeFakePluginStore(opts?.initialLocalId ?? null);
  const dropbox = makeFakeDropbox();
  if (opts?.remoteAt) {
    dropbox.store.set(vaultMetaPath(VAULT_PREFIX), opts.remoteAt);
  }
  const id = new VaultIdentity({
    pluginStore: store as never,
    dropbox: dropbox as never,
    vaultPrefix: VAULT_PREFIX,
    vaultName: VAULT_NAME,
    logger: makeLogger() as never,
    generateId: opts?.generateId ?? (() => VALID_UUID_A),
    now: () => NOW,
  });
  return { vi: id, store, dropbox };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VaultIdentity.ensureLocalVaultId', () => {
  it('generates and persists a UUID when data.json has none', async () => {
    const { vi: identity, store } = makeVaultIdentity({ initialLocalId: null });
    const id = await identity.ensureLocalVaultId();
    expect(id).toBe(VALID_UUID_A);
    expect(store.saveVaultId).toHaveBeenCalledWith(VALID_UUID_A);
    expect(store.currentVaultId).toBe(VALID_UUID_A);
  });

  it('is idempotent on a populated data.json', async () => {
    const { vi: identity, store } = makeVaultIdentity({ initialLocalId: VALID_UUID_B });
    const id = await identity.ensureLocalVaultId();
    expect(id).toBe(VALID_UUID_B);
    expect(store.saveVaultId).not.toHaveBeenCalled();
  });
});

describe('VaultIdentity.checkConsistency', () => {
  it('both sides absent → fresh-folder and locally generates a UUID', async () => {
    const { vi: identity, store } = makeVaultIdentity({
      initialLocalId: null,
      remoteAt: null,
    });
    const result = await identity.checkConsistency();
    expect(result.kind).toBe('fresh-folder');
    if (result.kind === 'fresh-folder') {
      expect(result.localId).toBe(VALID_UUID_A);
    }
    expect(store.currentVaultId).toBe(VALID_UUID_A);
  });

  it('local set + remote missing → fresh-folder using existing local id', async () => {
    const { vi: identity } = makeVaultIdentity({
      initialLocalId: VALID_UUID_B,
      remoteAt: null,
    });
    const result = await identity.checkConsistency();
    expect(result.kind).toBe('fresh-folder');
    if (result.kind === 'fresh-folder') expect(result.localId).toBe(VALID_UUID_B);
  });

  it('local missing + remote present → adopt-remote', async () => {
    const { vi: identity } = makeVaultIdentity({
      initialLocalId: null,
      remoteAt: makeVaultMeta(VALID_UUID_B, 'OtherVault'),
    });
    const result = await identity.checkConsistency();
    expect(result.kind).toBe('adopt-remote');
    if (result.kind === 'adopt-remote') {
      expect(result.remote.vault_id).toBe(VALID_UUID_B);
      expect(result.remote.vault_name).toBe('OtherVault');
    }
  });

  it('both set and matching → ok', async () => {
    const { vi: identity } = makeVaultIdentity({
      initialLocalId: VALID_UUID_A,
      remoteAt: makeVaultMeta(VALID_UUID_A),
    });
    const result = await identity.checkConsistency();
    expect(result.kind).toBe('ok');
  });

  it('both set and mismatch → mismatch', async () => {
    const { vi: identity } = makeVaultIdentity({
      initialLocalId: VALID_UUID_A,
      remoteAt: makeVaultMeta(VALID_UUID_B),
    });
    const result = await identity.checkConsistency();
    expect(result.kind).toBe('mismatch');
    if (result.kind === 'mismatch') {
      expect(result.localId).toBe(VALID_UUID_A);
      expect(result.remote.vault_id).toBe(VALID_UUID_B);
    }
  });

  it('remote schema invalid → remote-corrupt', async () => {
    const { vi: identity, dropbox } = makeVaultIdentity({
      initialLocalId: VALID_UUID_A,
      remoteAt: null,
    });
    // Manually seed an invalid blob at the meta path so loadRemoteVaultMeta
    // throws ConfigError when parsing it.
    dropbox.store.set(vaultMetaPath(VAULT_PREFIX), { not: 'a valid meta' });
    const result = await identity.checkConsistency();
    expect(result.kind).toBe('remote-corrupt');
    if (result.kind === 'remote-corrupt') {
      expect(result.localId).toBe(VALID_UUID_A);
      expect(result.rawError.length).toBeGreaterThan(0);
    }
  });
});

describe('VaultIdentity.claimRemote', () => {
  it('uploads a vault_meta with local id, current vault name, and ISO timestamp', async () => {
    const { vi: identity, dropbox } = makeVaultIdentity({
      initialLocalId: VALID_UUID_A,
      remoteAt: null,
    });
    await identity.claimRemote(VALID_UUID_A);
    const stored = dropbox.store.get(vaultMetaPath(VAULT_PREFIX)) as VaultMeta;
    expect(stored.vault_id).toBe(VALID_UUID_A);
    expect(stored.vault_name).toBe(VAULT_NAME);
    expect(stored.claimed_at).toBe(NOW.toISOString());
    expect(stored.schema_version).toBe(CURRENT_VAULT_META_SCHEMA);
  });
});

describe('VaultIdentity.adoptVaultId', () => {
  it('overwrites the local vault_id with the supplied value', async () => {
    const { vi: identity, store } = makeVaultIdentity({
      initialLocalId: null,
    });
    await identity.adoptVaultId(VALID_UUID_B);
    expect(store.saveVaultId).toHaveBeenCalledWith(VALID_UUID_B);
    expect(store.currentVaultId).toBe(VALID_UUID_B);
  });

  it('overrides an existing local id (re-adoption)', async () => {
    const { vi: identity, store } = makeVaultIdentity({
      initialLocalId: VALID_UUID_A,
    });
    await identity.adoptVaultId(VALID_UUID_B);
    expect(store.currentVaultId).toBe(VALID_UUID_B);
  });

  it('rejects a non-UUID vault_id without writing to data.json (M3)', async () => {
    const { vi: identity, store } = makeVaultIdentity({
      initialLocalId: VALID_UUID_A,
    });
    await expect(identity.adoptVaultId('not-a-uuid')).rejects.toMatchObject({
      code: 'VAULT_ID_INVALID',
    });
    // Local id must be untouched — saveVaultId never called.
    expect(store.saveVaultId).not.toHaveBeenCalled();
    expect(store.currentVaultId).toBe(VALID_UUID_A);
  });

  it('rejects an empty string', async () => {
    const { vi: identity, store } = makeVaultIdentity({ initialLocalId: null });
    await expect(identity.adoptVaultId('')).rejects.toMatchObject({
      code: 'VAULT_ID_INVALID',
    });
    expect(store.saveVaultId).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// L1: vault_id is truncated in log payloads
// ---------------------------------------------------------------------------

describe('VaultIdentity log redaction', () => {
  it('vault_id_generated logs a truncated id (first 8 chars + ellipsis)', async () => {
    const { vi: identity } = makeVaultIdentity({
      initialLocalId: null,
      generateId: () => VALID_UUID_A,
    });
    const logger = (
      identity as unknown as { deps: { logger: ReturnType<typeof makeLogger> } }
    ).deps.logger;
    await identity.ensureLocalVaultId();
    expect(logger.info).toHaveBeenCalledWith(
      'vault_id_generated',
      { vault_id: '3f2a8c1e…' },
    );
  });

  it('vault_id_adopted logs a truncated id', async () => {
    const { vi: identity } = makeVaultIdentity({ initialLocalId: null });
    const logger = (
      identity as unknown as { deps: { logger: ReturnType<typeof makeLogger> } }
    ).deps.logger;
    await identity.adoptVaultId(VALID_UUID_B);
    expect(logger.info).toHaveBeenCalledWith(
      'vault_id_adopted',
      { vault_id: '7c1e9b22…' },
    );
  });

  it('vault_meta_claimed logs a truncated id', async () => {
    const { vi: identity } = makeVaultIdentity({ initialLocalId: VALID_UUID_A });
    const logger = (
      identity as unknown as { deps: { logger: ReturnType<typeof makeLogger> } }
    ).deps.logger;
    await identity.claimRemote(VALID_UUID_A);
    expect(logger.info).toHaveBeenCalledWith(
      'vault_meta_claimed',
      { vault_id: '3f2a8c1e…' },
    );
  });
});
