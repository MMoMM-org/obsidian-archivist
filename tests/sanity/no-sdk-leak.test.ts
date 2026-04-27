// T5.6 — SDK-leak audit.
//
// Rule: only src/infra/DropboxClient.ts may import from the 'dropbox' npm SDK.
// All other service/model/infra files must use Archivist-owned types only.
//
// This test reads each monitored file and asserts that neither
// "from 'dropbox'" nor "from 'dropbox-sdk'" appears in the source text.

import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '../../src');

const SERVICES = [
  'services/BackupService.ts',
  'services/StartupRecovery.ts',
  'services/SnapshotIndexStore.ts',
  'services/MaintenanceScheduler.ts',
  'services/DeviceCoordinator.ts',
  'services/ManifestBuilder.ts',
];

describe('SDK-leak audit — no dropbox SDK imports outside DropboxClient', () => {
  for (const rel of SERVICES) {
    it(`${rel} does not import from the 'dropbox' SDK`, async () => {
      const source = await readFile(join(ROOT, rel), 'utf8');
      expect(source).not.toContain("from 'dropbox'");
      expect(source).not.toContain('from "dropbox"');
      expect(source).not.toContain("from 'dropbox-sdk'");
      expect(source).not.toContain('from "dropbox-sdk"');
    });
  }
});
