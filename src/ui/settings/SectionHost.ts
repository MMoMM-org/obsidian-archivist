// SectionHost — DOM boundary for SettingsTab section renderers.
//
// Each renderer (renderBackupSchedule / renderRetention / ...) takes a
// SectionHost and describes the UI declaratively. Production wiring
// (ArchivistSettingTab.getSettingDefinitions) passes a `DefinitionBuilderHost`
// that turns each call into an Obsidian setting definition; tests pass a
// `RecordingSectionHost` that collects a flat list of field specs and asserts
// structure without touching the DOM.
//
// Invariant: NO direct `innerHTML` or `createElement` in the renderers — only
// settings/customRows.ts touches DOM, inside the `Setting` Obsidian hands to
// each render row (CSP + plugin-review requirement).

import type { Setting } from 'obsidian';

/**
 * Declarative-settings metadata shared by every row kind (spec 002).
 * Search synonyms come from `S.ALIASES_*` (PRD F8).
 */
export interface RowMeta {
  /** Evaluated on each render; absent = always visible. */
  visible?: () => boolean;
  /** Extra search terms. Only meaningful on searchable rows. */
  aliases?: readonly string[];
}

/**
 * Input kinds persist a value, so each carries a stable `key`: the dotted
 * `PluginSettings` path it edits (e.g. `schedule.full_cadence`), unique within
 * its section. Rows that are not backed by `data.json` use the reserved `ui.`
 * prefix (e.g. `ui.device_designated`).
 */
export interface InputMeta extends RowMeta {
  key: string;
}

/**
 * What an input's `onChange` may return. A returned promise (the save or
 * ownership call) is awaited and caught by the settings tab, so a failure
 * never becomes an unhandled rejection.
 */
export type OnChangeResult = void | Promise<void>;

export interface TextFieldSpec extends InputMeta {
  kind: 'text';
  label: string;
  description?: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => OnChangeResult;
  validate?: (v: string) => string | null;
}

export interface ToggleFieldSpec extends InputMeta {
  kind: 'toggle';
  label: string;
  description?: string;
  value: boolean;
  onChange: (v: boolean) => OnChangeResult;
}

export interface NumberFieldSpec extends InputMeta {
  kind: 'number';
  label: string;
  description?: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => OnChangeResult;
  validate?: (v: number) => string | null;
}

export interface DropdownOption {
  value: string;
  label: string;
}

export interface DropdownFieldSpec extends InputMeta {
  kind: 'dropdown';
  label: string;
  description?: string;
  value: string;
  options: DropdownOption[];
  onChange: (v: string) => OnChangeResult;
}

export interface TextareaFieldSpec extends InputMeta {
  kind: 'textarea';
  label: string;
  description?: string;
  value: string;
  onChange: (v: string) => OnChangeResult;
  validate?: (v: string) => string | null;
}

export interface SliderFieldSpec extends InputMeta {
  kind: 'slider';
  label: string;
  description?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => OnChangeResult;
}

/**
 * Compact one-line row that combines a name + description + one or more inline
 * action buttons. Used for state-driven controls like the Dropbox Account row,
 * where the "stateful display" (Connected as …) and the "actions" (Re-auth /
 * Disconnect) belong together visually rather than as separate Setting rows.
 */
export interface ActionRowFieldSpec extends RowMeta {
  kind: 'actionRow';
  label: string;
  description?: string;
  actions: Array<{
    label: string;
    cta?: boolean;
    /** Marks a destructive action (e.g. Disconnect); styled as destructive by the host. */
    destructive?: boolean;
    onClick: () => void;
  }>;
}

export interface StaticTextSpec extends RowMeta {
  kind: 'static';
  text: string;
}

export interface LinkFieldSpec extends RowMeta {
  kind: 'link';
  label: string;
  href: string;
}

export interface BannerSpec extends RowMeta {
  kind: 'banner';
  code: string;
  message: string;
  severity: 'info' | 'warn' | 'error';
  /** Primary call-to-action — rendered as a CTA button (e.g. "Resolve").
   *  Resolves the underlying condition; distinct from dismissing the banner. */
  action?: { label: string; onClick: () => void };
  dismissLabel?: string;
  onDismiss?: () => void | Promise<void>;
}

export type FieldSpec =
  | TextFieldSpec
  | ToggleFieldSpec
  | NumberFieldSpec
  | DropdownFieldSpec
  | TextareaFieldSpec
  | SliderFieldSpec
  | ActionRowFieldSpec
  | StaticTextSpec
  | LinkFieldSpec
  | BannerSpec;

export interface SectionHost {
  heading(text: string): void;
  field(spec: FieldSpec): void;
  /**
   * Persistent banners rendered above a section (or at the top of the tab).
   * Distinct from `field({kind: 'banner'})` for the top-of-tab slot —
   * semantically they're the same but we keep the method separate so
   * renderers can request top-level banner placement.
   */
  topBanner(spec: BannerSpec): void;
}

/** Plugin identity shown in the settings-tab header row. */
export interface HeaderInfo {
  pluginName: string;
  version: string;
  /** Display name with any `<email>` suffix already stripped; absent = no author link. */
  authorName?: string;
  authorUrl?: string;
  docsUrl: string;
}

/**
 * Draws the non-input rows into an Obsidian `Setting` the declarative builder
 * hands over. A returned function is the row's cleanup hook.
 */
export interface CustomRowRenderers {
  header(setting: Setting, info: HeaderInfo): void | (() => void);
  banner(setting: Setting, spec: BannerSpec): void | (() => void);
  static(setting: Setting, spec: StaticTextSpec): void | (() => void);
  link(setting: Setting, spec: LinkFieldSpec): void | (() => void);
  actionRow(setting: Setting, spec: ActionRowFieldSpec): void | (() => void);
}
