// customRows — draws Archivist's non-input settings rows (spec 002, ADR-4).
//
// The declarative settings API hands each `render` row a `Setting` that
// Obsidian created and named. Header, banner, static text, link and action
// rows are not plain name/description pairs, so these callbacks replace the
// row's content with today's markup and `archivist-*` classes (styles.css is
// unchanged). Wherever today's look shows no label, the builder's internal
// name (e.g. `banner:<code>`) is cleared from `nameEl` so it never leaks into
// the UI. Only Setting and createEl APIs are used — no innerHTML.

import { requireApiVersion, type ButtonComponent, type Setting } from 'obsidian';
import type {
  ActionRowFieldSpec,
  BannerSpec,
  CustomRowRenderers,
  HeaderInfo,
  LinkFieldSpec,
  StaticTextSpec,
} from './SectionHost';

function renderHeader(setting: Setting, info: HeaderInfo): void {
  setting.nameEl.empty();
  const header = setting.infoEl.createDiv({ cls: 'archivist-version-header' });
  header.createSpan({ text: `${info.pluginName} `, cls: 'archivist-plugin-name' });
  header.createSpan({ text: `v${info.version}` });
  if (info.authorName) {
    header.createSpan({ text: ' · ', cls: 'archivist-header-sep' });
    header.createEl('a', { text: info.authorName, href: info.authorUrl ?? info.docsUrl });
  }
  header.createSpan({ text: ' · ', cls: 'archivist-header-sep' });
  header.createEl('a', { text: 'Documentation', href: info.docsUrl });
}

function renderBanner(setting: Setting, spec: BannerSpec): void {
  // spec.code stays internal (dedup / clear); only the message is shown.
  setting.setClass('archivist-banner').setClass(`archivist-banner-${spec.severity}`);
  setting.setName(spec.message);
  const { action, onDismiss } = spec;
  if (action) {
    setting.addButton((btn) => {
      btn.setButtonText(action.label).setCta().onClick(() => action.onClick());
    });
  }
  if (onDismiss) {
    setting.addButton((btn) => {
      btn.setButtonText(spec.dismissLabel ?? 'Dismiss').onClick(() => {
        void onDismiss();
      });
    });
  }
}

function renderStatic(setting: Setting, spec: StaticTextSpec): void {
  setting.nameEl.empty();
  setting.infoEl.createEl('p', { text: spec.text, cls: 'archivist-static-text' });
}

function renderLink(setting: Setting, spec: LinkFieldSpec): void {
  setting.nameEl.empty();
  const wrapper = setting.nameEl.createDiv({ cls: 'archivist-link-row' });
  wrapper.createEl('a', { text: spec.label, href: spec.href, cls: 'archivist-doc-link' });
}

// setDestructive() arrived in Obsidian 1.13.0; minAppVersion is 1.11.4 until
// spec 002 T3.3 raises it to 1.14.4, which can drop this guard. The fallback
// applies the same `mod-warning` class the deprecated setWarning() set.
function markDestructive(btn: ButtonComponent): void {
  if (requireApiVersion('1.13.0')) {
    btn.setDestructive();
  } else {
    btn.buttonEl.addClass('mod-warning');
  }
}

function renderActionRow(setting: Setting, spec: ActionRowFieldSpec): void {
  setting.setName(spec.label);
  if (spec.description) setting.setDesc(spec.description);
  for (const action of spec.actions) {
    setting.addButton((btn) => {
      btn.setButtonText(action.label).onClick(action.onClick);
      if (action.cta) btn.setCta();
      if (action.destructive) markDestructive(btn);
    });
  }
}

export const customRowRenderers: CustomRowRenderers = {
  header: renderHeader,
  banner: renderBanner,
  static: renderStatic,
  link: renderLink,
  actionRow: renderActionRow,
};
