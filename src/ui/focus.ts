// Focus capture for modals — remembers the element that had focus when a
// modal opened so it can be refocused on close (WCAG 2.4.3).
//
// Uses Obsidian's cross-window `instanceOf` instead of `instanceof`: in a
// popout window the focused element belongs to another realm, where
// `instanceof HTMLElement` is false and focus would silently not be restored
// (#114).

/** The document's focused element when it is an HTMLElement, else null. */
export function captureFocus(doc: Document): HTMLElement | null {
  const el = doc.activeElement;
  return el?.instanceOf(HTMLElement) ? el : null;
}
