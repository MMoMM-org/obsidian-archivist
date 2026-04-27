// Recording SectionHost — test utility. Collects every heading/field/banner
// call made by a section renderer so tests can assert against the spec list
// without touching the DOM.

import type { BannerSpec, FieldSpec, SectionHost } from '../../src/ui/settings/SectionHost';

export type RecordedEntry =
  | { kind: 'heading'; text: string }
  | { kind: 'field'; spec: FieldSpec }
  | { kind: 'topBanner'; spec: BannerSpec };

export class RecordingSectionHost implements SectionHost {
  readonly entries: RecordedEntry[] = [];

  heading(text: string): void {
    this.entries.push({ kind: 'heading', text });
  }

  field(spec: FieldSpec): void {
    this.entries.push({ kind: 'field', spec });
  }

  topBanner(spec: BannerSpec): void {
    this.entries.push({ kind: 'topBanner', spec });
  }

  // ---- Convenience accessors used by tests --------------------------------

  headings(): string[] {
    return this.entries.filter((e): e is { kind: 'heading'; text: string } => e.kind === 'heading').map((e) => e.text);
  }

  fields(): FieldSpec[] {
    return this.entries.filter((e): e is { kind: 'field'; spec: FieldSpec } => e.kind === 'field').map((e) => e.spec);
  }

  topBanners(): BannerSpec[] {
    return this.entries.filter((e): e is { kind: 'topBanner'; spec: BannerSpec } => e.kind === 'topBanner').map((e) => e.spec);
  }

  findField<K extends FieldSpec['kind']>(kind: K, label: string): Extract<FieldSpec, { kind: K }> | undefined {
    return this.fields().find(
      (f) => f.kind === kind && 'label' in f && f.label === label,
    ) as Extract<FieldSpec, { kind: K }> | undefined;
  }
}
