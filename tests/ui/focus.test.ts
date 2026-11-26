// #114 — modal focus capture must accept a focused element from another
// window (popout realm), where `instanceof HTMLElement` is false.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureFocus } from '../../src/ui/focus';

class FakeHTMLElement {}

/** An element whose prototype chain belongs to another realm. */
function crossRealmEl(isHtml: boolean): Element {
  return {
    instanceOf: (type: unknown) => isHtml && type === FakeHTMLElement,
  } as unknown as Element;
}

function docWith(active: Element | null): Document {
  return { activeElement: active } as unknown as Document;
}

describe('captureFocus', () => {
  const g = globalThis as { HTMLElement?: unknown };
  let saved: unknown;

  beforeEach(() => {
    saved = g.HTMLElement;
    g.HTMLElement = FakeHTMLElement;
  });
  afterEach(() => {
    g.HTMLElement = saved;
  });

  it('captures an HTMLElement from another window', () => {
    const el = crossRealmEl(true);
    expect(el instanceof FakeHTMLElement).toBe(false); // what the old check saw
    expect(captureFocus(docWith(el))).toBe(el);
  });

  it('returns null for a focused non-HTML element (e.g. SVG)', () => {
    expect(captureFocus(docWith(crossRealmEl(false)))).toBeNull();
  });

  it('returns null when nothing has focus', () => {
    expect(captureFocus(docWith(null))).toBeNull();
  });
});
