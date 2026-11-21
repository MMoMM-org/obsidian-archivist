// Recording SectionHost — test utility. Collects every heading/field/banner
// call made by a section renderer so tests can assert against the spec list
// without touching the DOM.
//
// Declarative metadata (spec 002): each recorded field also captures the
// spec's `key`, `visible` and `aliases`. FieldSpec gains those fields in T2.1;
// until then they are read loosely through `DeclarativeMeta` so this fixture
// compiles against either shape. `findField` mirrors Obsidian, which hides a
// row whose `visible()` returns false — pass `{ includeHidden: true }` to
// look up such a row anyway.

import type { BannerSpec, FieldSpec, SectionHost } from '../../src/ui/settings/SectionHost';

interface DeclarativeMeta {
  key?: string;
  visible?: () => boolean;
  aliases?: string[];
}

export type RecordedField = { kind: 'field'; spec: FieldSpec } & DeclarativeMeta;

export type RecordedEntry =
  | { kind: 'heading'; text: string }
  | RecordedField
  | { kind: 'topBanner'; spec: BannerSpec };

export interface FindFieldOptions {
  /** Also return specs whose `visible()` currently returns false. */
  includeHidden?: boolean;
}

export class RecordingSectionHost implements SectionHost {
  readonly entries: RecordedEntry[] = [];

  heading(text: string): void {
    this.entries.push({ kind: 'heading', text });
  }

  field(spec: FieldSpec): void {
    const meta = spec as FieldSpec & DeclarativeMeta;
    this.entries.push({ kind: 'field', spec, key: meta.key, visible: meta.visible, aliases: meta.aliases });
  }

  topBanner(spec: BannerSpec): void {
    this.entries.push({ kind: 'topBanner', spec });
  }

  // ---- Convenience accessors used by tests --------------------------------

  headings(): string[] {
    return this.entries.filter((e): e is { kind: 'heading'; text: string } => e.kind === 'heading').map((e) => e.text);
  }

  fieldEntries(): RecordedField[] {
    return this.entries.filter((e): e is RecordedField => e.kind === 'field');
  }

  fields(): FieldSpec[] {
    return this.fieldEntries().map((e) => e.spec);
  }

  topBanners(): BannerSpec[] {
    return this.entries.filter((e): e is { kind: 'topBanner'; spec: BannerSpec } => e.kind === 'topBanner').map((e) => e.spec);
  }

  findField<K extends FieldSpec['kind']>(
    kind: K,
    label: string,
    options: FindFieldOptions = {},
  ): Extract<FieldSpec, { kind: K }> | undefined {
    return this.fieldEntries().find(
      (e) =>
        e.spec.kind === kind &&
        'label' in e.spec &&
        e.spec.label === label &&
        (options.includeHidden === true || e.visible === undefined || e.visible()),
    )?.spec as Extract<FieldSpec, { kind: K }> | undefined;
  }
}
