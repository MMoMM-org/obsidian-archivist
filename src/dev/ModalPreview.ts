// Dev-only modal preview — opens the error-path modals with sample data so
// their layout can be checked in the test vault without provoking a real
// failure (no network outage, no vault-id mismatch).
//
// Registered only when the manifest version carries the `-dev.` suffix that
// esbuild.config.mjs stamps onto the test-vault copy; release manifests never
// have it. Every button is a no-op apart from closing the modal, so the
// preview cannot change the vault id, settings or anything on Dropbox.

import type { App, Plugin } from 'obsidian';
import { ErrorDetailsModal } from '../ui/ErrorDetailsModal';
import { MismatchRecoveryModal } from '../ui/MismatchRecoveryModal';
import { AdoptVaultModal } from '../ui/AdoptVaultModal';

const SAMPLE_REMOTE_ID = '00000000-0000-4000-8000-000000000000';
const noop = (): void => {};

/** True for the test-vault build (`<version>-dev.<YYYYMMDD-HHMM>`), never for a release. */
export function isDevBuild(version: string): boolean {
  return /-dev\.\d{8}-\d{4}$/.test(version);
}

interface PreviewDeps {
  plugin: Pick<Plugin, 'addCommand'> & { app: App; manifest: { version: string } };
}

export function registerDevModalPreviews({ plugin }: PreviewDeps): void {
  if (!isDevBuild(plugin.manifest.version)) return;
  const { app } = plugin;
  const previews: Array<[id: string, name: string, open: () => void]> = [
    ['dev-preview-error-details', 'Dev: preview error details modal', () => {
      new ErrorDetailsModal(app, {
        lastError: {
          code: 'NETWORK',
          message: 'Sample error (dev preview)',
          stack: null,
          at: Date.now(),
          kind: 'inc',
        },
        onOpenSettings: noop,
        onCopy: noop,
      }).open();
    }],
    ['dev-preview-mismatch-recovery', 'Dev: preview vault mismatch modal', () => {
      new MismatchRecoveryModal(app, {
        record: {
          kind: 'mismatch',
          localVaultId: null,
          remoteVaultId: SAMPLE_REMOTE_ID,
          remoteVaultName: 'Sample vault',
          rawError: null,
        },
        onAdoptRemote: () => Promise.resolve(),
        onChangePrefix: noop,
        onCancel: noop,
      }).open();
    }],
    ['dev-preview-adopt-vault', 'Dev: preview adopt vault modal', () => {
      new AdoptVaultModal(app, {
        remoteVaultName: 'Sample vault',
        remoteVaultId: SAMPLE_REMOTE_ID,
        onAdopt: noop,
        onCancel: noop,
      }).open();
    }],
  ];
  for (const [id, name, callback] of previews) plugin.addCommand({ id, name, callback });
}
