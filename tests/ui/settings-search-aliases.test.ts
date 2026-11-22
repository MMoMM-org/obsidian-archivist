// T4.2 (spec 002, PRD F8) — search synonyms. Obsidian's settings search
// indexes each definition's name, desc and aliases; these tests pin the
// exact F8 synonym table onto its rows, keep every other row alias-free, and
// make sure no synonym is another row's label (that would be a misleading hit).

import { describe, expect, it } from 'vitest';
import type { SettingDefinition, SettingDefinitionGroup } from 'obsidian';
import { DefinitionBuilderHost } from '../../src/ui/settings/DefinitionBuilderHost';
import type { CustomRowRenderers, SectionHost } from '../../src/ui/settings/SectionHost';
import type { SettingsContext } from '../../src/ui/settings/context';
import { renderBackupSchedule } from '../../src/ui/settings/sections/BackupSchedule';
import { renderRetention } from '../../src/ui/settings/sections/Retention';
import { renderNotifications } from '../../src/ui/settings/sections/Notifications';
import { renderAdvanced } from '../../src/ui/settings/sections/Advanced';
import { renderDropbox } from '../../src/ui/settings/sections/Dropbox';
import { DEFAULT_SETTINGS } from '../../src/model/Settings';
import { RecordingSectionHost, type RecordedField } from '../fixtures/recording-section-host';

/** PRD F8 synonym table, keyed by row identity (control key, or kind:label for render rows). */
const F8_TABLE: Record<string, string[]> = {
  'actionRow:Account': ['dropbox', 'cloud', 'connect', 'login'],
  'advanced.exclusion_globs': ['exclude', 'ignore', 'skip'],
  'schedule.inc_interval_minutes': ['interval', 'frequency'],
  'schedule.full_time_of_day': ['schedule', 'time'],
  'schedule.full_cadence': ['weekly', 'monthly'],
  'schedule.active_window_enabled': ['quiet hours', 'night'],
  'retention.daily_days': ['prune', 'keep'],
  'retention.storage_hard_limit_gb': ['quota', 'space'],
  'advanced.dry_run_mode': ['test', 'simulate'],
  'advanced.diagnostic_logging': ['debug', 'log'],
};

const ACCOUNT_STATES: Array<[string, string | null]> = [
  ['disconnected', null],
  ['connected', 'user@example.org'],
];

function stubContext(email: string | null): SettingsContext {
  return {
    getSettings: () => DEFAULT_SETTINGS,
    updateSettings: async () => {},
    deviceId: 'd0',
    deviceDesignated: true,
    dropboxAccountEmail: email,
    dropboxUsedBytes: 0,
    device: {
      getDeviceId: async () => 'd0',
      isDesignated: async () => true,
      takeOwnership: async () => {},
      releaseOwnership: async () => {},
    },
    dropbox: {
      getAccountEmail: async () => email,
      disconnect: async () => {},
      getUsedBytes: async () => 0,
    },
    oauth: {
      isConnected: async () => email !== null,
      beginAuth: async () => {},
    },
    getRetentionProfile: () => ({ vault_bytes: 0, avg_edits_per_day: 0 }),
    estimateRetention: () => ({ snapshots: 0, gb: 0 }),
    copyToClipboard: async () => {},
    confirm: async () => true,
  };
}

function renderAll(host: SectionHost, email: string | null): void {
  const ctx = stubContext(email);
  renderDropbox(host, ctx);
  renderBackupSchedule(host, ctx);
  renderRetention(host, ctx);
  renderNotifications(host, ctx);
  renderAdvanced(host, ctx);
}

function recordAll(email: string | null): RecordedField[] {
  const host = new RecordingSectionHost();
  renderAll(host, email);
  return host.fieldEntries();
}

function labelOf(entry: RecordedField): string | undefined {
  return 'label' in entry.spec ? entry.spec.label : undefined;
}

function identityOf(entry: RecordedField): string {
  return entry.key ?? `${entry.spec.kind}:${labelOf(entry) ?? '?'}`;
}

function buildDefinitions(email: string | null): SettingDefinition[] {
  const noop = (): void => {};
  const renderers: CustomRowRenderers = { header: noop, banner: noop, static: noop, link: noop, actionRow: noop };
  const builder = new DefinitionBuilderHost(renderers);
  renderAll(builder, email);
  const groups = builder.result().items as SettingDefinitionGroup[];
  return groups.flatMap((g) => (g.items ?? []) as SettingDefinition[]);
}

/** Case-insensitive substring match over the fields Obsidian's search indexes. */
function matches(def: SettingDefinition, query: string): boolean {
  if (def.searchable === false) return false;
  const q = query.toLowerCase();
  const haystack = [def.name, typeof def.desc === 'string' ? def.desc : '', ...(def.aliases ?? [])];
  return haystack.some((s) => s.toLowerCase().includes(q));
}

describe.each(ACCOUNT_STATES)('search synonyms — Dropbox %s', (_state, email) => {
  it('every PRD F8 table row carries exactly its listed synonyms', () => {
    const byId = new Map(recordAll(email).map((e) => [identityOf(e), e]));
    for (const [id, synonyms] of Object.entries(F8_TABLE)) {
      expect(byId.get(id), `row ${id} not rendered`).toBeDefined();
      expect(byId.get(id)?.aliases, `aliases of ${id}`).toEqual(synonyms);
    }
  });

  it('rows outside the F8 table carry no aliases', () => {
    const others = recordAll(email).filter((e) => !(identityOf(e) in F8_TABLE));
    expect(others.length).toBeGreaterThan(0);
    for (const entry of others) {
      expect(entry.aliases, `unexpected aliases on ${identityOf(entry)}`).toBeUndefined();
    }
  });

  it('no alias equals a different row’s label (case-insensitive)', () => {
    const entries = recordAll(email);
    for (const owner of entries) {
      for (const alias of owner.aliases ?? []) {
        const clash = entries.find(
          (other) => other !== owner && labelOf(other)?.toLowerCase() === alias.toLowerCase(),
        );
        expect(clash, `alias "${alias}" of ${identityOf(owner)} is a row label`).toBeUndefined();
      }
    }
  });

  it('the builder copies the aliases onto the definitions, including the Account render row', () => {
    const defs = buildDefinitions(email);
    const account = defs.find((d) => d.name === 'Account');
    expect(account?.aliases).toEqual(F8_TABLE['actionRow:Account']);
    const exclusion = defs.find((d) => d.control !== undefined && d.control.key === 'advanced.exclusion_globs');
    expect(exclusion?.aliases).toEqual(F8_TABLE['advanced.exclusion_globs']);
    const withAliases = defs.filter((d) => d.aliases !== undefined);
    expect(withAliases).toHaveLength(Object.keys(F8_TABLE).length);
  });

  it('each synonym finds its row (PRD F8 AC1)', () => {
    const defs = buildDefinitions(email);
    for (const synonyms of Object.values(F8_TABLE)) {
      for (const synonym of synonyms) {
        const hit = defs.find((d) => d.aliases?.includes(synonym) && matches(d, synonym));
        expect(hit, `synonym "${synonym}" finds no row`).toBeDefined();
      }
    }
  });

  it('a word unrelated to any synonym or label produces no Archivist hit (PRD F8 AC2)', () => {
    const defs = buildDefinitions(email);
    for (const word of ['banana', 'printer', 'xylophone']) {
      expect(defs.filter((d) => matches(d, word)).map((d) => d.name), word).toEqual([]);
    }
  });
});
