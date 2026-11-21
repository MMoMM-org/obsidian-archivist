// customRows — draws Archivist's non-input settings rows (spec 002, ADR-4).
//
// The declarative settings API hands each `render` row a `Setting` that
// Obsidian created and named. Header, banner, static text, link and action
// rows are not plain name/description pairs, so these callbacks replace the
// row's content with today's markup and `archivist-*` classes (styles.css is
// unchanged). Wherever today's look shows no label, the builder's internal
// name (e.g. `banner:<code>`) is cleared from `nameEl` so it never leaks into
// the UI. Only Setting and createEl APIs are used — no innerHTML.
//
// Re-render contract (verified in the 1.15.1 app.js): a row whose key survives
// update() keeps its Setting. Obsidian runs the previous render's cleanup,
// then Setting.clear() — which empties only controlEl — then resets name and
// description, then calls render again. So buttons and nameEl/descEl content
// are rebuilt by Obsidian, but anything a renderer appends to infoEl or adds
// to settingEl's classes persists. Those renderers return a cleanup that
// removes exactly what they added, so every pass leaves one copy.

import type { Setting } from 'obsidian';
import type {
  ActionRowFieldSpec,
  BannerSpec,
  CustomRowRenderers,
  HeaderInfo,
  LinkFieldSpec,
  StaticTextSpec,
} from './SectionHost';

type Cleanup = () => void;

function renderHeader(setting: Setting, info: HeaderInfo): Cleanup {
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
  return () => header.remove();
}

function renderBanner(setting: Setting, spec: BannerSpec): Cleanup {
  // spec.code stays internal (dedup / clear); only the message is shown.
  const classes = ['archivist-banner', `archivist-banner-${spec.severity}`];
  setting.settingEl.addClass(...classes);
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
  return () => setting.settingEl.removeClass(...classes);
}

function renderStatic(setting: Setting, spec: StaticTextSpec): Cleanup {
  setting.nameEl.empty();
  const text = setting.infoEl.createEl('p', { text: spec.text, cls: 'archivist-static-text' });
  return () => text.remove();
}

// No cleanup: the anchor lives in nameEl, which Obsidian resets via setName.
function renderLink(setting: Setting, spec: LinkFieldSpec): void {
  setting.nameEl.empty();
  const wrapper = setting.nameEl.createDiv({ cls: 'archivist-link-row' });
  wrapper.createEl('a', { text: spec.label, href: spec.href, cls: 'archivist-doc-link' });
}

// No cleanup: buttons live in controlEl, which Setting.clear() empties.
function renderActionRow(setting: Setting, spec: ActionRowFieldSpec): void {
  setting.setName(spec.label);
  if (spec.description) setting.setDesc(spec.description);
  for (const action of spec.actions) {
    setting.addButton((btn) => {
      btn.setButtonText(action.label).onClick(action.onClick);
      if (action.cta) btn.setCta();
      if (action.destructive) btn.setDestructive();
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
