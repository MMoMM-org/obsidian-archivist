// CustomRowRenderers (spec 002, T2.3) — draws header / banner / static / link /
// actionRow content into the Setting the declarative builder supplies. Each
// test hands the renderer a mock Setting whose name was already set to the
// builder's internal name, then asserts the DOM looks like today's tab.

import { describe, expect, it, vi } from 'vitest';
import { Setting, _reconcileRenderRow, type ButtonComponent, type MockEl } from '../fixtures/obsidian-mock';
import { customRowRenderers } from '../../src/ui/settings/customRows';
import type {
  ActionRowFieldSpec,
  BannerSpec,
  HeaderInfo,
  LinkFieldSpec,
  StaticTextSpec,
} from '../../src/ui/settings/SectionHost';

type MockSetting = Setting & { _buttons: ButtonComponent[] };

function suppliedSetting(internalName: string): MockSetting {
  return new Setting({}).setName(internalName) as MockSetting;
}

function asObsidian(setting: MockSetting): import('obsidian').Setting {
  return setting as unknown as import('obsidian').Setting;
}

function el(value: unknown): MockEl {
  return value as MockEl;
}

function texts(nodes: MockEl[]): string[] {
  return nodes.map((n) => n.textContent);
}

const INFO: HeaderInfo = {
  pluginName: 'Archivist',
  version: '0.11.1',
  authorName: 'Marcus',
  authorUrl: 'https://example.org/marcus',
  docsUrl: 'https://example.org/readme',
};

describe('customRowRenderers.header', () => {
  it('renders plugin name, version, author link and documentation link', () => {
    const setting = suppliedSetting('header');

    customRowRenderers.header(asObsidian(setting), INFO);

    const [header] = el(setting.settingEl).querySelectorAll('.archivist-version-header');
    expect(header).toBeDefined();
    expect(header.querySelectorAll('.archivist-plugin-name')[0].textContent).toBe('Archivist ');
    expect(texts(header.querySelectorAll('span'))).toContain('v0.11.1');
    const links = header.querySelectorAll('a');
    expect(texts(links)).toEqual(['Marcus', 'Documentation']);
    expect(links[0].attrs.href).toBe('https://example.org/marcus');
    expect(links[1].attrs.href).toBe('https://example.org/readme');
  });

  it('falls back to the docs URL for the author link when authorUrl is absent', () => {
    const setting = suppliedSetting('header');

    customRowRenderers.header(asObsidian(setting), { ...INFO, authorUrl: undefined });

    const [authorLink] = el(setting.settingEl).querySelectorAll('a');
    expect(authorLink.attrs.href).toBe('https://example.org/readme');
  });

  it('omits the author link and its separator when authorName is absent', () => {
    const setting = suppliedSetting('header');

    customRowRenderers.header(asObsidian(setting), { ...INFO, authorName: undefined });

    const root = el(setting.settingEl);
    expect(texts(root.querySelectorAll('a'))).toEqual(['Documentation']);
    expect(root.querySelectorAll('.archivist-header-sep')).toHaveLength(1);
  });

  it('clears the internal name text', () => {
    const setting = suppliedSetting('header');

    customRowRenderers.header(asObsidian(setting), INFO);

    expect(el(setting.nameEl).querySelectorAll('.archivist-version-header')).toHaveLength(0);
    expect(el(setting.nameEl).textContent).toBe('');
  });
});

function banner(extra: Partial<BannerSpec> = {}): BannerSpec {
  return { kind: 'banner', code: 'QUOTA', message: 'Dropbox is full.', severity: 'warn', ...extra };
}

describe('customRowRenderers.banner', () => {
  it('renders the message with the severity classes and replaces the internal name', () => {
    const setting = suppliedSetting('banner:QUOTA');

    customRowRenderers.banner(asObsidian(setting), banner({ severity: 'error' }));

    const classes = el(setting.settingEl).className.split(' ');
    expect(classes).toContain('archivist-banner');
    expect(classes).toContain('archivist-banner-error');
    expect(el(setting.nameEl).textContent).toBe('Dropbox is full.');
    expect(el(setting.nameEl).textContent).not.toContain('banner:');
  });

  it('renders no buttons without action or onDismiss', () => {
    const setting = suppliedSetting('banner:QUOTA');

    customRowRenderers.banner(asObsidian(setting), banner());

    expect(setting._buttons).toHaveLength(0);
  });

  it('renders the action as a CTA button that runs the action', () => {
    const setting = suppliedSetting('banner:QUOTA');
    const onClick = vi.fn();

    customRowRenderers.banner(asObsidian(setting), banner({ action: { label: 'Resolve', onClick } }));

    const [resolve] = setting._buttons;
    expect(resolve._text).toBe('Resolve');
    expect(resolve._cta).toBe(true);
    resolve._onClick?.({});
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('renders Dismiss with the default label after the action', () => {
    const setting = suppliedSetting('banner:QUOTA');
    const onDismiss = vi.fn();

    customRowRenderers.banner(
      asObsidian(setting),
      banner({ action: { label: 'Resolve', onClick: () => {} }, onDismiss }),
    );

    expect(setting._buttons.map((b) => b._text)).toEqual(['Resolve', 'Dismiss']);
    const dismiss = setting._buttons[1];
    expect(dismiss._cta).toBe(false);
    dismiss._onClick?.({});
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('uses dismissLabel when given', () => {
    const setting = suppliedSetting('banner:QUOTA');

    customRowRenderers.banner(asObsidian(setting), banner({ dismissLabel: 'Got it', onDismiss: () => {} }));

    expect(setting._buttons.map((b) => b._text)).toEqual(['Got it']);
  });
});

describe('customRowRenderers.static', () => {
  it('renders the text as an archivist-static-text paragraph and clears the internal name', () => {
    const setting = suppliedSetting('static:dropbox:0');
    const spec: StaticTextSpec = { kind: 'static', text: 'Backups go to your own Dropbox.' };

    customRowRenderers.static(asObsidian(setting), spec);

    const [p] = el(setting.settingEl).querySelectorAll('p');
    expect(p.className).toBe('archivist-static-text');
    expect(p.textContent).toBe('Backups go to your own Dropbox.');
    expect(el(setting.nameEl).querySelectorAll('p')).toHaveLength(0);
    expect(el(setting.nameEl).textContent).toBe('');
  });
});

describe('customRowRenderers.link', () => {
  it('replaces the name text with an archivist-doc-link anchor carrying the label', () => {
    const setting = suppliedSetting('Learn more');
    const spec: LinkFieldSpec = { kind: 'link', label: 'Learn more', href: 'https://example.org/docs' };

    customRowRenderers.link(asObsidian(setting), spec);

    const nameEl = el(setting.nameEl);
    expect(nameEl.querySelectorAll('.archivist-link-row')).toHaveLength(1);
    const [a] = nameEl.querySelectorAll('a');
    expect(a.className).toBe('archivist-doc-link');
    expect(a.textContent).toBe('Learn more');
    expect(a.attrs.href).toBe('https://example.org/docs');
    expect(nameEl.textContent).toBe('');
  });
});

function actionRow(actions: ActionRowFieldSpec['actions'], description?: string): ActionRowFieldSpec {
  return { kind: 'actionRow', label: 'Account', description, actions };
}

describe('customRowRenderers.actionRow', () => {
  it('keeps the label as name and sets the description', () => {
    const setting = suppliedSetting('Account');

    customRowRenderers.actionRow(asObsidian(setting), actionRow([], 'Connected as a@b.c'));

    expect(el(setting.nameEl).textContent).toBe('Account');
    expect(el(setting.descEl).textContent).toBe('Connected as a@b.c');
  });

  it('renders buttons in order; destructive only on destructive, CTA only on CTA actions', () => {
    const setting = suppliedSetting('Account');
    const onDisconnect = vi.fn();

    customRowRenderers.actionRow(
      asObsidian(setting),
      actionRow([
        { label: 'Re-authenticate', onClick: () => {} },
        { label: 'Upgrade', cta: true, onClick: () => {} },
        { label: 'Disconnect', destructive: true, onClick: onDisconnect },
      ]),
    );

    const [reauth, upgrade, disconnect] = setting._buttons;
    expect(setting._buttons.map((b) => b._text)).toEqual(['Re-authenticate', 'Upgrade', 'Disconnect']);
    expect([reauth._destructive, upgrade._destructive, disconnect._destructive]).toEqual([false, false, true]);
    expect([reauth._cta, upgrade._cta, disconnect._cta]).toEqual([false, true, false]);
    disconnect._onClick?.({});
    expect(onDisconnect).toHaveBeenCalledOnce();
  });

  it('renders a lone neutral action (Connect) with neither destructive nor CTA styling', () => {
    const setting = suppliedSetting('Account');

    customRowRenderers.actionRow(asObsidian(setting), actionRow([{ label: 'Connect Dropbox', onClick: () => {} }]));

    const [connect] = setting._buttons;
    expect(connect._destructive).toBe(false);
    expect(connect._cta).toBe(false);
  });
});

// Obsidian keeps a render row's Setting across update() when its key is
// unchanged, runs the previous cleanup, clear()s the Setting (controlEl only),
// resets name/desc and renders again (see _reconcileRenderRow). Each renderer
// must leave exactly one copy of its content after any number of passes.
describe('customRowRenderers on a Setting reused across update()', () => {
  type Draw = (setting: import('obsidian').Setting) => void | (() => void);

  function renderPasses(name: string, draw: Draw, passes = 3, desc?: string): MockSetting {
    const setting = new Setting({}) as MockSetting;
    const def = { name, desc, render: (s: Setting) => draw(asObsidian(s as MockSetting)) };
    for (let i = 0; i < passes; i++) _reconcileRenderRow(setting, def);
    return setting;
  }

  function classTokens(setting: MockSetting): string[] {
    return el(setting.settingEl).className.split(' ');
  }

  it('header: one version header with one set of spans and links', () => {
    const setting = renderPasses('header', (s) => customRowRenderers.header(s, INFO));

    const headers = el(setting.settingEl).querySelectorAll('.archivist-version-header');
    expect(headers).toHaveLength(1);
    expect(texts(headers[0].querySelectorAll('a'))).toEqual(['Marcus', 'Documentation']);
    expect(el(setting.infoEl).children).toHaveLength(3);
    expect(el(setting.nameEl).textContent).toBe('');
  });

  it('static: one paragraph of text', () => {
    const spec: StaticTextSpec = { kind: 'static', text: 'Tokens are kept in Obsidian.' };
    const setting = renderPasses('static:dropbox:0', (s) => customRowRenderers.static(s, spec));

    expect(texts(el(setting.settingEl).querySelectorAll('.archivist-static-text'))).toEqual([
      'Tokens are kept in Obsidian.',
    ]);
    expect(el(setting.infoEl).children).toHaveLength(3);
    expect(el(setting.nameEl).textContent).toBe('');
  });

  it('banner: one message, each class once, one set of buttons', () => {
    const spec = banner({ action: { label: 'Resolve', onClick: () => {} }, onDismiss: () => {} });
    const setting = renderPasses('banner:QUOTA', (s) => customRowRenderers.banner(s, spec));

    expect(el(setting.nameEl).textContent).toBe('Dropbox is full.');
    expect(classTokens(setting).filter((c) => c.startsWith('archivist-banner'))).toEqual([
      'archivist-banner',
      'archivist-banner-warn',
    ]);
    expect(setting._buttons.map((b) => b._text)).toEqual(['Resolve', 'Dismiss']);
    expect(el(setting.controlEl).children).toHaveLength(2);
  });

  it('banner: its cleanup removes exactly the classes it added', () => {
    const setting = new Setting({}) as MockSetting;
    const cleanup = customRowRenderers.banner(asObsidian(setting), banner({ severity: 'error' }));

    expect(typeof cleanup).toBe('function');
    (cleanup as () => void)();

    expect(classTokens(setting)).toEqual(['setting-item']);
  });

  it('link: one link row with one anchor', () => {
    const spec: LinkFieldSpec = { kind: 'link', label: 'Learn more', href: 'https://example.org/docs' };
    const setting = renderPasses('Learn more', (s) => customRowRenderers.link(s, spec));

    expect(el(setting.nameEl).querySelectorAll('.archivist-link-row')).toHaveLength(1);
    expect(el(setting.nameEl).querySelectorAll('a')).toHaveLength(1);
  });

  it('actionRow: one set of buttons, name and description', () => {
    const spec = actionRow(
      [{ label: 'Re-authenticate', onClick: () => {} }, { label: 'Disconnect', destructive: true, onClick: () => {} }],
      'Connected as a@b.c',
    );
    const setting = renderPasses('Account', (s) => customRowRenderers.actionRow(s, spec), 3, spec.description);

    expect(setting._buttons.map((b) => b._text)).toEqual(['Re-authenticate', 'Disconnect']);
    expect(el(setting.controlEl).children).toHaveLength(2);
    expect(el(setting.nameEl).textContent).toBe('Account');
    expect(el(setting.descEl).textContent).toBe('Connected as a@b.c');
  });
});

// A runtime that runs a render's cleanup only on teardown (possibly 1.14.4 —
// unverified) re-renders into the same Setting with neither the cleanup nor
// clear() in between. Header and static must still drop their previous output
// themselves; banner's classes are idempotent by classList semantics.
describe('customRowRenderers re-rendered without cleanup or clear()', () => {
  type Draw = (setting: import('obsidian').Setting) => void | (() => void);

  function drawRepeatedly(draw: Draw, passes = 3): MockSetting {
    const setting = suppliedSetting('internal');
    for (let i = 0; i < passes; i++) draw(asObsidian(setting));
    return setting;
  }

  it('header: one version header in infoEl', () => {
    const setting = drawRepeatedly((s) => customRowRenderers.header(s, INFO));

    const headers = el(setting.infoEl).querySelectorAll('.archivist-version-header');
    expect(headers).toHaveLength(1);
    expect(texts(headers[0].querySelectorAll('a'))).toEqual(['Marcus', 'Documentation']);
    expect(el(setting.infoEl).children).toHaveLength(3);
  });

  it('static: one paragraph of text in infoEl', () => {
    const spec: StaticTextSpec = { kind: 'static', text: 'Tokens are kept in Obsidian.' };
    const setting = drawRepeatedly((s) => customRowRenderers.static(s, spec));

    expect(texts(el(setting.infoEl).querySelectorAll('.archivist-static-text'))).toEqual([
      'Tokens are kept in Obsidian.',
    ]);
    expect(el(setting.infoEl).children).toHaveLength(3);
  });

  it('banner: each class once and the message', () => {
    const setting = drawRepeatedly((s) => customRowRenderers.banner(s, banner({ severity: 'error' })));

    expect(el(setting.settingEl).className.split(' ')).toEqual([
      'setting-item',
      'archivist-banner',
      'archivist-banner-error',
    ]);
    expect(el(setting.nameEl).textContent).toBe('Dropbox is full.');
  });

  it('a late cleanup after redraws removes the current copy and is harmless twice', () => {
    const setting = suppliedSetting('header');
    const first = customRowRenderers.header(asObsidian(setting), INFO) as () => void;
    const second = customRowRenderers.header(asObsidian(setting), INFO) as () => void;

    first();
    expect(el(setting.infoEl).querySelectorAll('.archivist-version-header')).toHaveLength(1);
    second();
    second();
    expect(el(setting.infoEl).querySelectorAll('.archivist-version-header')).toHaveLength(0);
  });
});
