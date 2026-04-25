// SectionHost — DOM boundary for SettingsTab section renderers.
//
// Each renderer (renderBackupSchedule / renderRetention / ...) takes a
// SectionHost and describes the UI declaratively. Production wiring
// (SettingsTab.display) constructs an `ObsidianSectionHost` that materialises
// each call as `new Setting(containerEl)...` per Obsidian's plugin API; tests
// pass a `RecordingSectionHost` that collects a flat list of field specs and
// asserts structure without touching the DOM.
//
// Invariant: NO direct `innerHTML` or `createElement` in the renderers — only
// the ObsidianSectionHost implementation touches DOM, and it routes every
// field through Obsidian's Setting class (CSP + plugin-review requirement).

export interface TextFieldSpec {
  kind: 'text';
  label: string;
  description?: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
  validate?: (v: string) => string | null;
}

export interface ToggleFieldSpec {
  kind: 'toggle';
  label: string;
  description?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}

export interface NumberFieldSpec {
  kind: 'number';
  label: string;
  description?: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
  validate?: (v: number) => string | null;
}

export interface DropdownOption {
  value: string;
  label: string;
}

export interface DropdownFieldSpec {
  kind: 'dropdown';
  label: string;
  description?: string;
  value: string;
  options: DropdownOption[];
  onChange: (v: string) => void;
}

export interface TextareaFieldSpec {
  kind: 'textarea';
  label: string;
  description?: string;
  value: string;
  onChange: (v: string) => void;
  validate?: (v: string) => string | null;
}

export interface SliderFieldSpec {
  kind: 'slider';
  label: string;
  description?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}

export interface ButtonFieldSpec {
  kind: 'button';
  label: string;
  cta?: boolean;
  onClick: () => void;
}

export interface ReadOnlyFieldSpec {
  kind: 'readonly';
  label: string;
  description?: string;
  value: string;
  copyable?: boolean;
}

export interface StaticTextSpec {
  kind: 'static';
  text: string;
}

export interface LinkFieldSpec {
  kind: 'link';
  label: string;
  href: string;
}

export interface BannerSpec {
  kind: 'banner';
  code: string;
  message: string;
  severity: 'info' | 'warn' | 'error';
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
  | ButtonFieldSpec
  | ReadOnlyFieldSpec
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
