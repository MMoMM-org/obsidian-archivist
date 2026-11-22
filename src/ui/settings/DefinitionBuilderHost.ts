// DefinitionBuilderHost — the bridge from Archivist's FieldSpec stream to
// Obsidian's declarative settings API (spec 002, ADR-1).
//
// Section renderers keep describing their rows through `SectionHost`; this
// host collects them as `SettingDefinitionItem[]` so Obsidian can index every
// row for settings search. Input kinds become `control` rows (Obsidian owns
// the widget and calls back through getControlValue/setControlValue); every
// other kind becomes a `render` row that delegates to the injected
// `CustomRowRenderers`. The host also keeps the key → spec registry for this
// build and exports `guardWrite`, the pure accept/reject rule that keeps
// today's silent-reject write semantics.
//
// No DOM here: only Obsidian *types* are imported, and render callbacks just
// forward the `Setting` Obsidian hands in.

import type {
  SettingControl,
  SettingDefinition,
  SettingDefinitionBase,
  SettingDefinitionItem,
  SettingDefinitionRender,
} from 'obsidian';
import type {
  BannerSpec,
  CustomRowRenderers,
  DropdownFieldSpec,
  FieldSpec,
  HeaderInfo,
  NumberFieldSpec,
  RowMeta,
  SectionHost,
  SliderFieldSpec,
  TextareaFieldSpec,
  TextFieldSpec,
  ToggleFieldSpec,
} from './SectionHost';

/** FieldSpec kinds that persist a value and map to an Obsidian `control`. */
export type InputFieldSpec =
  | TextFieldSpec
  | ToggleFieldSpec
  | NumberFieldSpec
  | DropdownFieldSpec
  | TextareaFieldSpec
  | SliderFieldSpec;

export interface DefinitionBuildResult {
  items: SettingDefinitionItem[];
  registry: Map<string, InputFieldSpec>;
}

export type GuardResult = { accept: true; value: unknown } | { accept: false };

interface GroupDraft {
  heading?: string;
  items: SettingDefinition[];
  keys: Set<string>;
  staticCount: number;
}

type RenderFn = SettingDefinitionRender['render'];

const INPUT_KINDS: ReadonlySet<FieldSpec['kind']> = new Set([
  'text', 'toggle', 'number', 'dropdown', 'textarea', 'slider',
]);

function isInput(spec: FieldSpec): spec is InputFieldSpec {
  return INPUT_KINDS.has(spec.kind);
}

/** name/desc/aliases/visible, copied only when the spec sets them (aliases as a fresh array). */
function baseOf(meta: RowMeta, name: string, desc?: string): SettingDefinitionBase {
  const base: SettingDefinitionBase = { name };
  if (desc !== undefined) base.desc = desc;
  if (meta.aliases !== undefined) base.aliases = [...meta.aliases];
  if (meta.visible !== undefined) base.visible = meta.visible;
  return base;
}

function textValidate(spec: TextFieldSpec): ((v: string) => string | undefined) | undefined {
  const validate = spec.validate;
  return validate ? (v) => validate(v) ?? undefined : undefined;
}

function controlOf(spec: InputFieldSpec): SettingControl {
  const key = spec.key;
  switch (spec.kind) {
    case 'text':
      return dropUndefined({ type: 'text', key, placeholder: spec.placeholder, validate: textValidate(spec) });
    case 'toggle':
      return { type: 'toggle', key };
    case 'number':
      return dropUndefined({ type: 'number', key, min: spec.min, max: spec.max, step: spec.step });
    case 'dropdown':
      // Integer-like keys iterate in ascending numeric order; every option set
      // emitted today is already ascending, so the visible order is preserved.
      return { type: 'dropdown', key, options: Object.fromEntries(spec.options.map((o) => [o.value, o.label])) };
    case 'textarea':
      return { type: 'textarea', key };
    case 'slider':
      return { type: 'slider', key, min: spec.min, max: spec.max, step: spec.step };
  }
}

function dropUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

function guardNumber(spec: NumberFieldSpec, value: unknown): GuardResult {
  const n = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(n)) return { accept: false };
  if (spec.min !== undefined && n < spec.min) return { accept: false };
  if (spec.max !== undefined && n > spec.max) return { accept: false };
  if (spec.validate?.(n)) return { accept: false };
  return { accept: true, value: n };
}

function guardString(spec: TextFieldSpec | TextareaFieldSpec, value: unknown): GuardResult {
  const s = String(value);
  if (spec.validate?.(s)) return { accept: false };
  return { accept: true, value: s };
}

/**
 * Pure write guard mirroring the legacy imperative tab: number and textarea
 * reject silently on parse/range/validate failure, text re-runs its validator
 * (Obsidian should already have refused, this keeps parity if it did not),
 * the rest pass through. The caller invokes `spec.onChange(value)` on accept.
 */
export function guardWrite(spec: InputFieldSpec, value: unknown): GuardResult {
  switch (spec.kind) {
    case 'number':
      return guardNumber(spec, value);
    case 'text':
    case 'textarea':
      return guardString(spec, value);
    default:
      return { accept: true, value };
  }
}

export class DefinitionBuilderHost implements SectionHost {
  private readonly top: GroupDraft = newGroup();
  private readonly groups: GroupDraft[] = [this.top];
  private current: GroupDraft = this.top;
  private headerRow: SettingDefinition | null = null;
  private readonly registry = new Map<string, InputFieldSpec>();

  constructor(private readonly renderers: CustomRowRenderers) {}

  heading(text: string): void {
    this.current = newGroup(text);
    this.groups.push(this.current);
  }

  topBanner(spec: BannerSpec): void {
    this.top.items.push(this.bannerRow(spec));
  }

  header(info: HeaderInfo): void {
    const render: RenderFn = (setting) => this.renderers.header(setting, info);
    this.headerRow = { name: 'header', searchable: false, render };
  }

  field(spec: FieldSpec): void {
    if (isInput(spec)) this.addControl(spec);
    else this.current.items.push(this.renderRow(spec));
  }

  result(): DefinitionBuildResult {
    const items = this.groups.map((g): SettingDefinitionItem => ({
      type: 'group',
      ...(g.heading !== undefined ? { heading: g.heading } : {}),
      items: g === this.top && this.headerRow ? [this.headerRow, ...g.items] : [...g.items],
    }));
    return { items, registry: new Map(this.registry) };
  }

  private addControl(spec: InputFieldSpec): void {
    const group = this.current;
    if (group.keys.has(spec.key)) {
      throw new Error(`DefinitionBuilderHost: duplicate control key "${spec.key}" in group "${groupName(group)}"`);
    }
    group.keys.add(spec.key);
    this.registry.set(spec.key, spec);
    group.items.push({ ...baseOf(spec, spec.label, spec.description), control: controlOf(spec) });
  }

  private renderRow(spec: Exclude<FieldSpec, InputFieldSpec>): SettingDefinition {
    const r = this.renderers;
    switch (spec.kind) {
      case 'banner':
        return this.bannerRow(spec);
      case 'static': {
        const name = `static:${groupName(this.current)}:${this.current.staticCount++}`;
        return { ...baseOf(spec, name), searchable: false, render: (s) => r.static(s, spec) };
      }
      case 'link':
        return { ...baseOf(spec, spec.label), render: (s) => r.link(s, spec) };
      case 'actionRow':
        return { ...baseOf(spec, spec.label, spec.description), render: (s) => r.actionRow(s, spec) };
      case 'readonly':
      case 'button':
        throw new Error(`DefinitionBuilderHost: "${spec.kind}" rows are unsupported (#112)`);
    }
  }

  private bannerRow(spec: BannerSpec): SettingDefinition {
    const render: RenderFn = (setting) => this.renderers.banner(setting, spec);
    return { ...baseOf(spec, `banner:${spec.code}`), searchable: false, render };
  }
}

function newGroup(heading?: string): GroupDraft {
  return { heading, items: [], keys: new Set(), staticCount: 0 };
}

function groupName(group: GroupDraft): string {
  return group.heading ?? 'top';
}
