// Advanced section (T7.9 — PRD S1 + Advanced settings).
//
// Fields:
//   - Exclusion globs (textarea, per-line validation via validateGlob)
//   - Reconcile-scan toggle (ON default)
//   - Dry-run toggle (OFF default)
//   - Vault-prefix text (regex /^[a-z0-9][a-z0-9_-]{1,63}$/; change opens
//     confirm modal — migration warning)
//   - Diagnostic-logging toggle (OFF default — path redaction gate)
//   - Upload-parallelism slider (1–8, default 4)
//   - Chunk-size slider (4–64 MB, default 8)

import type { SectionHost } from '../SectionHost';
import type { SettingsContext } from '../context';
import { S } from '../../strings';
import type { AdvancedSettings } from '../../../model/Settings';
import { validateGlob } from '../../../util/glob';

const VAULT_PREFIX_REGEX = /^[a-z0-9][a-z0-9_-]{1,63}$/;

export function renderAdvanced(host: SectionHost, ctx: SettingsContext): void {
  host.heading(S.SETTINGS_SECTION_ADVANCED);

  const settings = ctx.getSettings();
  const a = settings.advanced;

  // ---- Exclusion globs (textarea) -----------------------------------------
  host.field({
    kind: 'textarea',
    label: S.SETTINGS_EXCLUSION_GLOBS,
    description: S.SETTINGS_EXCLUSION_GLOBS_HELP,
    value: a.exclusion_globs.join('\n'),
    onChange: (raw) => {
      const lines = raw
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      void ctx.updateSettings({
        advanced: merge(a, { exclusion_globs: lines }),
      });
    },
    validate: (raw) => {
      // Validate each non-empty line; first error wins.
      const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
      for (const line of lines) {
        const err = validateGlob(line);
        if (err) return `"${line}": ${err}`;
      }
      return null;
    },
  });

  // ---- Reconcile scan toggle ----------------------------------------------
  host.field({
    kind: 'toggle',
    label: S.SETTINGS_RECONCILE_SCAN,
    value: a.reconcile_scan_enabled,
    onChange: (v) => {
      void ctx.updateSettings({ advanced: merge(a, { reconcile_scan_enabled: v }) });
    },
  });

  // ---- Dry-run toggle -----------------------------------------------------
  host.field({
    kind: 'toggle',
    label: S.SETTINGS_DRY_RUN,
    value: a.dry_run_mode,
    onChange: (v) => {
      void ctx.updateSettings({ advanced: merge(a, { dry_run_mode: v }) });
    },
  });

  // ---- Diagnostic logging toggle ------------------------------------------
  host.field({
    kind: 'toggle',
    label: S.SETTINGS_DIAGNOSTIC_LOGGING,
    description: 'Off by default. Only enable when capturing logs for a bug report — paths become visible.',
    value: a.diagnostic_logging,
    onChange: (v) => {
      void ctx.updateSettings({ advanced: merge(a, { diagnostic_logging: v }) });
    },
  });

  // ---- Vault prefix (with confirm modal on change) ------------------------
  host.field({
    kind: 'text',
    label: S.SETTINGS_VAULT_PREFIX,
    description: S.SETTINGS_VAULT_PREFIX_HELP,
    value: a.vault_prefix,
    onChange: (v) => {
      if (!VAULT_PREFIX_REGEX.test(v)) return;
      if (v === a.vault_prefix) return;
      void (async (): Promise<void> => {
        const ok = await ctx.confirm({
          title: 'Change Dropbox vault folder?',
          body:
            'Changing the folder name starts a fresh backup history at the new path. ' +
            'Your previous backups remain under the old folder until you clean them up manually.',
          okLabel: 'Change folder',
          cancelLabel: 'Cancel',
        });
        if (!ok) return;
        await ctx.updateSettings({ advanced: merge(a, { vault_prefix: v }) });
      })();
    },
    validate: (v) =>
      VAULT_PREFIX_REGEX.test(v)
        ? null
        : 'Lowercase letters, numbers, hyphens, underscores; 2–64 characters; must start with a letter or digit.',
  });

  // ---- Upload parallelism slider -----------------------------------------
  host.field({
    kind: 'slider',
    label: S.SETTINGS_UPLOAD_PARALLELISM,
    value: a.upload_parallelism,
    min: 1,
    max: 8,
    step: 1,
    onChange: (v) => {
      void ctx.updateSettings({ advanced: merge(a, { upload_parallelism: v }) });
    },
  });

  // ---- Chunk size slider --------------------------------------------------
  host.field({
    kind: 'slider',
    label: S.SETTINGS_CHUNK_SIZE,
    value: a.chunk_size_mb,
    min: 4,
    max: 64,
    step: 1,
    onChange: (v) => {
      void ctx.updateSettings({ advanced: merge(a, { chunk_size_mb: v }) });
    },
  });
}

function merge(current: AdvancedSettings, patch: Partial<AdvancedSettings>): AdvancedSettings {
  return { ...current, ...patch };
}
