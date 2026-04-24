// T9.4 — PreviewPane: safe rendering + co-installed plugin advisory.
//
// Tests verify:
//   1. Malicious content (XSS payloads) never executes — rendered as text.
//   2. Binary files never reach the markdown renderer; placeholder is shown.
//   3. Path rendering uses text-node insertion; HTML-special chars are literals.
//   4. detectCodeEvalPlugins returns enabled risky plugin IDs.
//   5. maybeShowPreviewAdvisory fires a one-time advisory when risky plugins
//      are present and the user hasn't dismissed it.
//   6. The advisory is NOT fired a second time once dismissed.

import { describe, expect, it, vi } from 'vitest';
import {
  renderPreview,
  renderPathSpan,
  detectCodeEvalPlugins,
  maybeShowPreviewAdvisory,
} from '../../src/ui/PreviewPane';
import { App, Component, MarkdownRenderer } from '../fixtures/obsidian-mock';
import type { MockEl } from '../fixtures/obsidian-mock';
import { S } from '../../src/ui/strings';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEl(): MockEl {
  const children: MockEl[] = [];
  const el: MockEl = {
    tagName: 'div',
    children,
    textContent: '',
    className: '',
    attrs: {},
    listeners: new Map(),
    _focusCalled: false,
    createEl(tag, opts = {}) {
      const child = makeEl();
      child.tagName = tag;
      if (opts.text !== undefined) child.textContent = opts.text;
      if (opts.cls !== undefined) child.className = opts.cls;
      if (opts.attr) child.attrs = { ...opts.attr };
      el.children.push(child);
      return child;
    },
    createDiv(opts = {}) {
      return el.createEl('div', { cls: opts.cls });
    },
    createSpan(opts = {}) {
      return el.createEl('span', opts);
    },
    setText(text) {
      el.textContent = text;
    },
    addClass(cls) {
      el.className = el.className ? `${el.className} ${cls}` : cls;
    },
    addEventListener(_event, _cb) {},
    dispatchEvent(_e) {},
    focus() {
      el._focusCalled = true;
    },
  };
  return el;
}

function makeApp(): App {
  return new App();
}

function makeComponent(): Component {
  return new Component();
}

function encodeText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// Build a Uint8Array with high-byte values that cannot be valid UTF-8 text.
function makeBinaryBytes(): Uint8Array {
  // PNG magic bytes: \x89 PNG\r\n\x1a\n
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

function makeAppWithPlugins(pluginIds: string[]): { plugins: { enabledPlugins: Set<string> } } {
  return { plugins: { enabledPlugins: new Set(pluginIds) } };
}

// Collect all textContent values from a tree recursively.
function collectText(el: MockEl): string {
  if (el.children.length === 0) return el.textContent;
  return el.children.map(collectText).join('') + el.textContent;
}

// ---------------------------------------------------------------------------
// Section 1: renderPreview — XSS payloads rendered as text, not executed
// ---------------------------------------------------------------------------

describe('renderPreview — XSS payloads are neutralized', () => {
  it('<script> tag in content is not executed; rendered as text', async () => {
    const el = makeEl();
    const content = encodeText('<script>alert("xss")</script># Hello');
    await renderPreview(makeApp(), el, content, 'note.md', makeComponent());
    const text = collectText(el);
    expect(text).not.toContain('<script>');
    // The content must appear in some form (blocked or escaped), not silently dropped
    expect(text.length).toBeGreaterThan(0);
  });

  it('javascript: URL in content is not injected as href', async () => {
    const el = makeEl();
    const content = encodeText('[click me](javascript:alert(1))');
    await renderPreview(makeApp(), el, content, 'note.md', makeComponent());
    // Confirm no child has an href attr with javascript:
    function hasJsHref(e: MockEl): boolean {
      if (e.attrs['href'] && e.attrs['href'].toLowerCase().startsWith('javascript:')) return true;
      return e.children.some(hasJsHref);
    }
    expect(hasJsHref(el)).toBe(false);
  });

  it('onerror= attribute in content is not injected as DOM attribute', async () => {
    const el = makeEl();
    const content = encodeText('<img src=x onerror=alert(1)>');
    await renderPreview(makeApp(), el, content, 'note.md', makeComponent());
    function hasOnerror(e: MockEl): boolean {
      if ('onerror' in e.attrs) return true;
      return e.children.some(hasOnerror);
    }
    expect(hasOnerror(el)).toBe(false);
  });

  it('MarkdownRenderer.render is called for text content, not innerHTML', async () => {
    const spy = vi.spyOn(MarkdownRenderer, 'render');
    const el = makeEl();
    const content = encodeText('# Safe heading\n\nSome text.');
    const app = makeApp();
    const component = makeComponent();
    await renderPreview(app, el, content, 'note.md', component);
    expect(spy).toHaveBeenCalledOnce();
    // args: app, string content, el, sourcePath, component
    const [calledApp, calledContent, calledEl, calledPath] = spy.mock.calls[0];
    expect(calledApp).toBe(app);
    expect(calledContent).toContain('Safe heading');
    expect(calledEl).toBe(el);
    expect(calledPath).toBe('note.md');
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Section 2: renderPreview — binary files use placeholder, skip renderer
// ---------------------------------------------------------------------------

describe('renderPreview — binary files show placeholder', () => {
  it('binary bytes (PNG magic) never reach MarkdownRenderer.render', async () => {
    const spy = vi.spyOn(MarkdownRenderer, 'render');
    const el = makeEl();
    await renderPreview(makeApp(), el, makeBinaryBytes(), 'image.png', makeComponent());
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('binary file shows S.FILE_HISTORY_BINARY_PLACEHOLDER text', async () => {
    const el = makeEl();
    await renderPreview(makeApp(), el, makeBinaryBytes(), 'photo.png', makeComponent());
    const text = collectText(el);
    expect(text).toContain(S.FILE_HISTORY_BINARY_PLACEHOLDER);
  });

  it('PDF extension triggers binary placeholder regardless of content', async () => {
    const spy = vi.spyOn(MarkdownRenderer, 'render');
    const el = makeEl();
    const content = encodeText('not really a pdf but has .pdf extension');
    await renderPreview(makeApp(), el, content, 'document.pdf', makeComponent());
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('image extensions (jpg, gif, webp) trigger binary placeholder', async () => {
    for (const ext of ['photo.jpg', 'anim.gif', 'icon.webp']) {
      const spy = vi.spyOn(MarkdownRenderer, 'render');
      const el = makeEl();
      await renderPreview(makeApp(), el, makeBinaryBytes(), ext, makeComponent());
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it('text file with .md extension uses MarkdownRenderer even if bytes look odd', async () => {
    const spy = vi.spyOn(MarkdownRenderer, 'render');
    const el = makeEl();
    const content = encodeText('# Note\nSome content here.');
    await renderPreview(makeApp(), el, content, 'note.md', makeComponent());
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Section 3: File-tree path rendering — SEC-L2
// Path must be rendered as literal text, never as markup.
// ---------------------------------------------------------------------------

describe('renderPathSpan — path rendering is text-safe (SEC-L2)', () => {
  it('renders a normal path as span text', () => {
    const el = makeEl();
    renderPathSpan(el, 'notes/journal/2025-01-15.md');
    const span = el.children.find((c) => c.tagName === 'span');
    expect(span).toBeDefined();
    expect(span!.textContent).toBe('notes/journal/2025-01-15.md');
  });

  it('path with < > " & is rendered as literal text (not HTML entities)', () => {
    const el = makeEl();
    const evilPath = 'folder/<script>/note"&<name>.md';
    renderPathSpan(el, evilPath);
    const span = el.children.find((c) => c.tagName === 'span');
    expect(span).toBeDefined();
    // textContent must equal the raw string, not HTML-escaped entities
    expect(span!.textContent).toBe(evilPath);
    // The span must NOT have innerHTML-style attrs that could inject HTML
    expect(Object.keys(span!.attrs)).not.toContain('innerHTML');
  });

  it('does not set innerHTML anywhere in the tree', () => {
    const el = makeEl();
    renderPathSpan(el, '<evil>path</evil>');
    function hasInnerHTML(e: MockEl): boolean {
      if ('innerHTML' in e.attrs) return true;
      return e.children.some(hasInnerHTML);
    }
    expect(hasInnerHTML(el)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Section 4: detectCodeEvalPlugins
// ---------------------------------------------------------------------------

describe('detectCodeEvalPlugins', () => {
  it('returns empty array when no risky plugins are enabled', () => {
    const app = makeAppWithPlugins(['some-other-plugin', 'obsidian-calendar']);
    expect(detectCodeEvalPlugins(app)).toEqual([]);
  });

  it('returns ["dataview"] when dataview is enabled', () => {
    const app = makeAppWithPlugins(['dataview', 'obsidian-calendar']);
    expect(detectCodeEvalPlugins(app)).toContain('dataview');
  });

  it('returns ["templater-obsidian"] when templater is enabled', () => {
    const app = makeAppWithPlugins(['templater-obsidian']);
    expect(detectCodeEvalPlugins(app)).toContain('templater-obsidian');
  });

  it('returns ["obsidian-tasks-plugin"] when tasks plugin is enabled', () => {
    const app = makeAppWithPlugins(['obsidian-tasks-plugin']);
    expect(detectCodeEvalPlugins(app)).toContain('obsidian-tasks-plugin');
  });

  it('returns all risky plugins when all three are enabled', () => {
    const app = makeAppWithPlugins(['dataview', 'templater-obsidian', 'obsidian-tasks-plugin']);
    const result = detectCodeEvalPlugins(app);
    expect(result).toContain('dataview');
    expect(result).toContain('templater-obsidian');
    expect(result).toContain('obsidian-tasks-plugin');
    expect(result).toHaveLength(3);
  });

  it('returns empty array when no plugins are enabled at all', () => {
    const app = makeAppWithPlugins([]);
    expect(detectCodeEvalPlugins(app)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Section 5: maybeShowPreviewAdvisory — co-installed plugin advisory (SEC-H3)
// ---------------------------------------------------------------------------

interface FakeNoticeCenter {
  _calls: Array<{ code: string; message: string; dismissLabel?: string; onDismiss?: () => void | Promise<void> }>;
  showPersistent: (code: string, message: string, opts?: { onDismiss?: () => void | Promise<void>; dismissLabel?: string }) => void;
}

function makeFakeNoticeCenter(): FakeNoticeCenter {
  const calls: Array<{ code: string; message: string; dismissLabel?: string; onDismiss?: () => void | Promise<void> }> = [];
  return {
    _calls: calls,
    showPersistent(code, message, opts) {
      calls.push({ code, message, dismissLabel: opts?.dismissLabel, onDismiss: opts?.onDismiss });
    },
  };
}

describe('maybeShowPreviewAdvisory', () => {
  it('fires advisory notice when risky plugins are present and not dismissed', () => {
    const app = makeAppWithPlugins(['dataview']);
    const noticeCenter = makeFakeNoticeCenter();
    const isDismissed = () => false;
    const saveSettings = vi.fn();

    maybeShowPreviewAdvisory(app, noticeCenter, isDismissed, saveSettings);

    expect(noticeCenter._calls).toHaveLength(1);
    expect(noticeCenter._calls[0].message).toBe(S.PREVIEW_PLUGIN_ADVISORY);
    expect(noticeCenter._calls[0].dismissLabel).toBe(S.PREVIEW_PLUGIN_ADVISORY_DISMISS);
  });

  it('does NOT fire advisory when no risky plugins are present', () => {
    const app = makeAppWithPlugins(['obsidian-calendar']);
    const noticeCenter = makeFakeNoticeCenter();
    const isDismissed = () => false;
    const saveSettings = vi.fn();

    maybeShowPreviewAdvisory(app, noticeCenter, isDismissed, saveSettings);

    expect(noticeCenter._calls).toHaveLength(0);
  });

  it('does NOT fire advisory when already dismissed', () => {
    const app = makeAppWithPlugins(['dataview', 'templater-obsidian']);
    const noticeCenter = makeFakeNoticeCenter();
    const isDismissed = () => true;
    const saveSettings = vi.fn();

    maybeShowPreviewAdvisory(app, noticeCenter, isDismissed, saveSettings);

    expect(noticeCenter._calls).toHaveLength(0);
  });

  it('calls saveSettings when the advisory is dismissed', async () => {
    const app = makeAppWithPlugins(['dataview']);
    const noticeCenter = makeFakeNoticeCenter();
    const isDismissed = () => false;
    const saveSettings = vi.fn().mockResolvedValue(undefined);

    maybeShowPreviewAdvisory(app, noticeCenter, isDismissed, saveSettings);

    expect(noticeCenter._calls).toHaveLength(1);
    const capturedDismiss = noticeCenter._calls[0].onDismiss;
    expect(capturedDismiss).toBeDefined();
    await capturedDismiss!();
    expect(saveSettings).toHaveBeenCalledOnce();
  });

  it('advisory uses a stable PREVIEW_ADVISORY banner code', () => {
    const app = makeAppWithPlugins(['dataview']);
    const noticeCenter = makeFakeNoticeCenter();

    maybeShowPreviewAdvisory(app, noticeCenter, () => false, vi.fn());

    expect(noticeCenter._calls[0].code).toBe('PREVIEW_ADVISORY');
  });
});
