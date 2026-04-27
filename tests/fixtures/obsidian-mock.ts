/**
 * Minimal Obsidian API mock for lifecycle tests (T1.4).
 * Tracks registrations in internal arrays so tests can assert hygiene.
 * Future phases extend this file — keep additions lean and additive.
 */

// Opaque type for event references
export type EventRef = { _id: number; _event: string };

let _nextId = 0;

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export class Workspace {
  /** Map<eventName, Set<EventRef>> — test introspection hook */
  _listeners: Map<string, Set<EventRef>> = new Map();

  private _layoutReadyCallbacks: Array<() => void> = [];
  private _layoutReady = false;

  on(event: string, _handler: (...args: unknown[]) => unknown): EventRef {
    const ref: EventRef = { _id: ++_nextId, _event: event };
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event)!.add(ref);
    return ref;
  }

  /** Remove a ref (called by Plugin base during cleanup). */
  offref(ref: EventRef): void {
    const bucket = this._listeners.get(ref._event);
    if (bucket) bucket.delete(ref);
  }

  /** Phase 4 addition (T4.4): subscribe to layout-ready. */
  onLayoutReady(cb: () => void): void {
    if (this._layoutReady) cb();
    else this._layoutReadyCallbacks.push(cb);
  }

  /** Test helper: fire layout-ready, delivering pending callbacks once. */
  _fireLayoutReady(): void {
    this._layoutReady = true;
    for (const cb of this._layoutReadyCallbacks) cb();
    this._layoutReadyCallbacks = [];
  }
}

// ---------------------------------------------------------------------------
// TAbstractFile / TFile / TFolder (Phase 4 addition)
// ---------------------------------------------------------------------------
// Minimal stubs matching the Obsidian API surface used by VaultAdapter.

export class TAbstractFile {
  path: string;
  constructor(path: string) {
    this.path = path;
  }
}

export class TFile extends TAbstractFile {
  stat: { mtime: number; size: number };
  constructor(path: string, stat?: { mtime: number; size: number }) {
    super(path);
    this.stat = stat ?? { mtime: 0, size: 0 };
  }
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
  constructor(path: string) {
    super(path);
  }
}

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

export class Vault {
  /** Tracked TFile instances for getFiles(). */
  private _files: TFile[] = [];

  /** In-memory binary store for readBinary/writeBinary. */
  private _binaryStore: Map<string, Uint8Array> = new Map();

  adapter: {
    read: (path: string) => Promise<string>;
    write: (path: string, data: string) => Promise<void>;
    exists: (path: string) => Promise<boolean>;
    remove: (path: string) => Promise<void>;
    // Phase 4 additions
    readBinary: (path: string) => Promise<ArrayBuffer>;
    writeBinary: (path: string, data: ArrayBuffer) => Promise<void>;
    rename: (from: string, to: string) => Promise<void>;
    stat: (path: string) => Promise<{ mtime: number; size: number; type: 'file' | 'folder' } | null>;
    mkdir: (path: string) => Promise<void>;
    _statStore: Map<string, { mtime: number; size: number; type: 'file' | 'folder' }>;
    _setStat: (path: string, stat: { mtime: number; size: number; type: 'file' | 'folder' }) => void;
  };

  /** Map<eventName, Set<handler>> for event fire/listen. */
  private _eventHandlers: Map<string, Set<((...args: unknown[]) => void)>> = new Map();

  constructor() {
    const binaryStore = this._binaryStore;
    const statStore = new Map<string, { mtime: number; size: number; type: 'file' | 'folder' }>();

    this.adapter = {
      read: async (_path: string): Promise<string> => '',
      write: async (_path: string, _data: string): Promise<void> => {},
      exists: async (path: string): Promise<boolean> => binaryStore.has(path),
      // Phase 3 addition
      remove: async (_path: string): Promise<void> => {},
      // Phase 4 additions
      readBinary: async (path: string): Promise<ArrayBuffer> => {
        const bytes = binaryStore.get(path);
        if (bytes === undefined) {
          throw new Error(`ENOENT: no such file: ${path}`);
        }
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
      writeBinary: async (path: string, data: ArrayBuffer): Promise<void> => {
        binaryStore.set(path, new Uint8Array(data));
      },
      rename: async (from: string, to: string): Promise<void> => {
        const bytes = binaryStore.get(from);
        if (bytes !== undefined) {
          binaryStore.set(to, bytes);
          binaryStore.delete(from);
        }
      },
      stat: async (path: string) => statStore.get(path) ?? null,
      mkdir: async (_path: string): Promise<void> => {},
      _statStore: statStore,
      _setStat(path, stat) {
        statStore.set(path, stat);
      },
    };
  }

  // ---- Test helpers --------------------------------------------------------

  /**
   * Register a TFile and seed its binary content.
   * Automatically seeds an empty Uint8Array of `stat.size` bytes so that
   * `readBinary` calls on this file do not throw ENOENT.  Tests that need
   * specific content should call `_setFileBytes` afterwards.
   */
  _addFile(path: string, stat: { mtime: number; size: number }): TFile {
    const file = new TFile(path, stat);
    this._files.push(file);
    if (!this._binaryStore.has(path)) {
      this._binaryStore.set(path, new Uint8Array(stat.size));
    }
    return file;
  }

  /** Seed raw bytes for readBinary. */
  _setFileBytes(path: string, bytes: Uint8Array): void {
    this._binaryStore.set(path, bytes);
  }

  /** Check if a path has bytes in the store. */
  _hasFile(path: string): boolean {
    return this._binaryStore.has(path);
  }

  /** Retrieve stored bytes (for assertions). */
  _getFileBytes(path: string): Uint8Array | undefined {
    return this._binaryStore.get(path);
  }

  // ---- Obsidian API surface ------------------------------------------------

  getFiles(): TFile[] {
    return [...this._files];
  }

  /**
   * Return the TFile registered for `path`, or null. Mirror of Obsidian's
   * Vault.getAbstractFileByPath, narrowed to TFile (TFolder support is
   * unused in tests so far). Tests that need a TFile-backed write code
   * path must call `_addFile(path, ...)` to register the file.
   */
  getAbstractFileByPath(path: string): TFile | null {
    return this._files.find((f) => f.path === path) ?? null;
  }

  /**
   * High-level binary modify — equivalent to vault.adapter.writeBinary at
   * the storage layer, but in production also refreshes the metadata cache
   * + open editor views. Tests only care about the data, so we update the
   * binary store directly.
   */
  async modifyBinary(file: TFile, data: ArrayBuffer): Promise<void> {
    this._binaryStore.set(file.path, new Uint8Array(data));
  }

  /** Mirror Workspace.on semantics — used by VaultAdapter.on*() methods. */
  on(event: string, handler: (...args: unknown[]) => void): EventRef {
    if (!this._eventHandlers.has(event)) this._eventHandlers.set(event, new Set());
    this._eventHandlers.get(event)!.add(handler);
    const ref: EventRef = { _id: ++_nextId, _event: event };
    return ref;
  }

  /** offref — mirrors Workspace.offref; used during plugin teardown. */
  offref(_ref: EventRef): void {
    // In the mock we don't track ref→handler mapping; teardown is best-effort.
  }

  /** Test helper: fire a vault event, delivering args to registered handlers. */
  _fire(event: string, ...args: unknown[]): void {
    const handlers = this._eventHandlers.get(event);
    if (!handlers) return;
    for (const h of handlers) {
      h(...args);
    }
  }
}

// ---------------------------------------------------------------------------
// Platform (Phase 3 addition)
// ---------------------------------------------------------------------------
// Tests can override via `vi.mock('obsidian', ...)` when they need the mobile
// branch. Default is desktop because that's where TokenStore chmod runs.

export const Platform = { isDesktopApp: true };

// ---------------------------------------------------------------------------
// FileSystemAdapter (Phase 3 addition)
// ---------------------------------------------------------------------------
// Desktop-only adapter subclass. `getFullPath` resolves a vault-relative path
// to the absolute filesystem path, which TokenStore needs before calling
// Node's fs.chmod.

export class FileSystemAdapter {
  private basePath = '/tmp/mock-vault';

  getBasePath(): string {
    return this.basePath;
  }

  getFullPath(relativePath: string): string {
    return `${this.basePath}/${relativePath}`;
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export class App {
  workspace: Workspace = new Workspace();
  vault: Vault = new Vault();
  /**
   * Phase 7 addition: plugin introspection surface. Not part of Obsidian's
   * public typings (it's on the internal API), but Archivist's predecessor
   * detection needs it — see src/services/PredecessorDetector.ts.
   */
  plugins: { enabledPlugins: Set<string> } = { enabledPlugins: new Set<string>() };
}

// ---------------------------------------------------------------------------
// Command type (matches Obsidian's Command interface)
// ---------------------------------------------------------------------------

export interface Command {
  id: string;
  name: string;
  callback?: () => void;
  checkCallback?: (checking: boolean) => boolean | void;
}

// ---------------------------------------------------------------------------
// Plugin base class
// ---------------------------------------------------------------------------

export interface ObsidianProtocolData {
  action: string;
  [key: string]: string;
}

export type ObsidianProtocolHandler = (params: ObsidianProtocolData) => unknown;

export class Plugin {
  app: App;
  manifest: { id: string; name: string; version: string };

  /** Internal registry — cleared by onunload. Exposed for test introspection. */
  _registeredEvents: EventRef[] = [];
  _registeredIntervals: ReturnType<typeof setInterval>[] = [];
  /**
   * Phase 3 addition (T3.3): records handlers passed to
   * registerObsidianProtocolHandler so tests can drive OAuth callbacks.
   * Keyed by action string (e.g. 'archivist-oauth').
   */
  _protocolHandlers: Map<string, ObsidianProtocolHandler> = new Map();

  constructor(app: App, manifest: { id: string; name: string; version: string }) {
    this.app = app;
    this.manifest = manifest;
  }

  // ---- Registration helpers (all via registerX for lifecycle hygiene) ------

  registerEvent(ref: EventRef): void {
    this._registeredEvents.push(ref);
  }

  registerInterval(id: ReturnType<typeof setInterval>): ReturnType<typeof setInterval> {
    this._registeredIntervals.push(id);
    return id;
  }

  registerDomEvent(
    _el: EventTarget,
    _event: string,
    _cb: EventListenerOrEventListenerObject,
  ): void {
    // DOM events are tracked internally; no teardown needed in this mock.
  }

  addRibbonIcon(
    _icon: string,
    _title: string,
    _cb: (evt: MouseEvent) => unknown,
  ): HTMLElement {
    // Production code uses Obsidian's addClass / removeClass / setAttribute /
    // addEventListener / setText / createSpan / empty / remove on the returned
    // element. Vitest runs in a node environment with no DOM, so we hand back
    // a MockEl that satisfies those surfaces; cast to HTMLElement for the
    // typings that the production code reaches through.
    return makeMockEl('div') as unknown as HTMLElement;
  }

  addStatusBarItem(): HTMLElement {
    return makeMockEl('div') as unknown as HTMLElement;
  }

  addCommand(command: Command): Command {
    return command;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  addSettingTab(_tab: unknown): void {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  registerView(_viewType: string, _viewCreator: unknown): void {}

  registerObsidianProtocolHandler(action: string, handler: ObsidianProtocolHandler): void {
    this._protocolHandlers.set(action, handler);
  }

  async loadData(): Promise<unknown> {
    return null;
  }

  async saveData(_data: unknown): Promise<void> {}

  // ---- Lifecycle -----------------------------------------------------------

  async onload(): Promise<void> {}

  async onunload(): Promise<void> {
    // Auto-clean all events registered via registerEvent.
    for (const ref of this._registeredEvents) {
      this.app.workspace.offref(ref);
    }
    this._registeredEvents = [];

    // Auto-clear all intervals registered via registerInterval.
    for (const id of this._registeredIntervals) {
      clearInterval(id);
    }
    this._registeredIntervals = [];
  }
}

// ---------------------------------------------------------------------------
// Notice (no-op stub — Archivist will use this in later phases)
// ---------------------------------------------------------------------------

export class Notice {
  constructor(_message: string, _timeout?: number) {}
}

// ---------------------------------------------------------------------------
// PluginSettingTab + Setting + setIcon + setTooltip — Phase 7 additions
// ---------------------------------------------------------------------------
// These stubs are intentionally minimal. UI tests bypass them by exercising
// section renderers directly with a RecordingSectionHost (see
// tests/fixtures/recording-section-host.ts). The stubs exist so modules that
// `import { PluginSettingTab, Setting } from 'obsidian'` can load in vitest.

export class PluginSettingTab {
  app: App;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plugin: any;
  containerEl: { empty: () => void; createEl: (...args: unknown[]) => unknown; createDiv: (...args: unknown[]) => unknown };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(app: App, plugin: any) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = {
      empty: (): void => {},
      createEl: (): unknown => ({ createEl: (): unknown => ({}), createSpan: (): unknown => ({}) }),
      createDiv: (): unknown => ({ createEl: (): unknown => ({}), createSpan: (): unknown => ({}) }),
    };
  }

  display(): void {}
  hide(): void {}
}

export class Setting {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_container: unknown) {}
  setName(_n: string): this {
    return this;
  }
  setDesc(_d: string): this {
    return this;
  }
  addText(_cb: (t: unknown) => void): this {
    return this;
  }
  addTextArea(_cb: (t: unknown) => void): this {
    return this;
  }
  addToggle(_cb: (t: unknown) => void): this {
    return this;
  }
  addDropdown(_cb: (d: unknown) => void): this {
    return this;
  }
  addButton(_cb: (b: unknown) => void): this {
    return this;
  }
  addSlider(_cb: (s: unknown) => void): this {
    return this;
  }
}

export function setIcon(_el: unknown, _iconName: string): void {}
export function setTooltip(_el: unknown, _tooltip: string): void {}

// ---------------------------------------------------------------------------
// Modal — Phase 9 addition (T9.3)
// ---------------------------------------------------------------------------
// A minimal but structurally complete stub of the Obsidian Modal class.
// Production subclasses call super(app), then manipulate this.contentEl.
// Tests instantiate the subclass directly, drive keyboard events through
// _fireKeydown(), and inspect calls via _opened / _closed.

export interface MockEl {
  tagName: string;
  children: MockEl[];
  textContent: string;
  className: string;
  attrs: Record<string, string>;
  listeners: Map<string, Array<(e: { key: string; preventDefault: () => void }) => void>>;
  createEl<T extends string>(
    tag: T,
    opts?: { text?: string; cls?: string; attr?: Record<string, string> },
  ): MockEl;
  createDiv(opts?: { cls?: string }): MockEl;
  createSpan(opts?: { text?: string; cls?: string }): MockEl;
  setText(text: string): void;
  addClass(cls: string): void;
  removeClass(cls: string): void;
  /** Detach the element from its parent (mirrors HTMLElement.remove()). */
  remove(): void;
  /** Remove all child elements (mirrors Obsidian HTMLElement.empty()). */
  empty(): void;
  /** Set a DOM attribute (mirrors HTMLElement.setAttribute). */
  setAttribute(name: string, value: string): void;
  /** Remove a DOM attribute (mirrors HTMLElement.removeAttribute). */
  removeAttribute(name: string): void;
  addEventListener(
    event: string,
    cb: (e: { key: string; preventDefault: () => void }) => void,
  ): void;
  dispatchEvent(e: { key: string; preventDefault: () => void; type: string }): void;
  focus(): void;
  _focusCalled: boolean;
  /**
   * Minimal selector engine — supports `.class`, `tag`, and the
   * descendant-then-tag combo `.class tag` used by views to find
   * specific buttons inside an action row. Not a full CSS engine.
   */
  querySelectorAll<T extends MockEl = MockEl>(selector: string): T[];
}

function makeMockEl(tag: string): MockEl {
  const el: MockEl = {
    tagName: tag,
    children: [],
    textContent: '',
    className: '',
    attrs: {},
    listeners: new Map(),
    _focusCalled: false,
    createEl(childTag, opts = {}) {
      const child = makeMockEl(childTag);
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
      const tokens = el.className ? el.className.split(/\s+/).filter(Boolean) : [];
      if (!tokens.includes(cls)) tokens.push(cls);
      el.className = tokens.join(' ');
    },
    removeClass(cls) {
      const tokens = el.className ? el.className.split(/\s+/).filter(Boolean) : [];
      el.className = tokens.filter((t) => t !== cls).join(' ');
    },
    remove() {
      // Detach is a no-op in this stub; tests that need parent-child tracking
      // would need a richer scaffold. Existing tests only assert teardown is
      // called, not the parent-side state.
    },
    empty() {
      el.children.length = 0;
      el.textContent = '';
    },
    setAttribute(name, value) {
      el.attrs[name] = value;
    },
    removeAttribute(name) {
      delete el.attrs[name];
    },
    addEventListener(event, cb) {
      if (!el.listeners.has(event)) el.listeners.set(event, []);
      el.listeners.get(event)!.push(cb);
    },
    dispatchEvent(e) {
      const cbs = el.listeners.get(e.type);
      if (cbs) for (const cb of cbs) cb(e);
    },
    focus() {
      el._focusCalled = true;
    },
    querySelectorAll<T extends MockEl = MockEl>(selector: string): T[] {
      // Strip leading dot for class selectors. Supports two forms:
      //   ".cls"       → all descendants whose className contains cls
      //   ".cls tag"   → tag descendants whose ancestor matches .cls
      //   "tag"        → all descendants of the given tag name
      const parts = selector.trim().split(/\s+/);
      const matches: MockEl[] = [];
      const matchOne = (node: MockEl, sel: string): boolean => {
        if (sel.startsWith('.')) return node.className.includes(sel.slice(1));
        if (sel.startsWith('[')) return false; // attribute selectors not supported
        return node.tagName === sel;
      };
      const walk = (node: MockEl, idx: number, gateMet: boolean): void => {
        for (const child of node.children) {
          const childGate = gateMet || matchOne(child, parts[idx]);
          if (idx === parts.length - 1) {
            if (childGate || matchOne(child, parts[idx])) {
              if (matchOne(child, parts[parts.length - 1])) matches.push(child);
            }
          }
          // For multi-segment selectors, advance the gate index when matched.
          const nextIdx = matchOne(child, parts[idx]) && idx < parts.length - 1
            ? idx + 1
            : idx;
          walk(child, nextIdx, childGate);
        }
      };
      walk(el, 0, false);
      return matches as T[];
    },
  };
  return el;
}

export class Modal {
  app: App;
  contentEl: MockEl;
  modalEl: MockEl;

  /** Test introspection: was open() called? */
  _opened = false;
  /** Test introspection: was close() called? */
  _closed = false;
  /** Element that had focus before modal opened (focus-return target). */
  _triggerEl: MockEl | null = null;

  constructor(app: App) {
    this.app = app;
    this.modalEl = makeMockEl('div');
    this.contentEl = this.modalEl.createEl('div', { cls: 'modal-content' });
  }

  open(): void {
    this._opened = true;
    this.onOpen();
    // Obsidian Modal wires keydown on the modal element for Escape handling.
    // We don't replicate that here — subclasses that need it must call
    // this.modalEl.addEventListener('keydown', ...) in onOpen().
  }

  close(): void {
    this._closed = true;
    this.onClose();
    if (this._triggerEl) {
      this._triggerEl.focus();
    }
  }

  /** Override in subclass. */
  onOpen(): void {}
  /** Override in subclass. */
  onClose(): void {}

  /** Test helper: fire a keydown event on the modal element. */
  _fireKeydown(key: string): void {
    let defaultPrevented = false;
    const e = {
      key,
      type: 'keydown',
      preventDefault: () => { defaultPrevented = true; },
      _defaultPrevented: () => defaultPrevented,
    };
    this.modalEl.dispatchEvent(e);
  }
}

// ---------------------------------------------------------------------------
// Menu — minimal mock for context-menu testing
// ---------------------------------------------------------------------------
// Captures addItem callbacks and the showAtMouseEvent call. Tests poke
// `_lastMenu` to assert items were registered and to fire onClicks.

export interface MenuItemMock {
  title: string;
  icon: string;
  onClickCallbacks: Array<() => void>;
  setTitle(title: string): MenuItemMock;
  setIcon(icon: string): MenuItemMock;
  onClick(cb: () => void): MenuItemMock;
}

export class Menu {
  items: MenuItemMock[] = [];
  shown = false;
  shownAt: unknown = null;

  /** Test introspection: most recently constructed Menu instance. */
  static _last: Menu | null = null;

  constructor() {
    Menu._last = this;
  }

  addItem(builder: (item: MenuItemMock) => void): this {
    const item: MenuItemMock = {
      title: '',
      icon: '',
      onClickCallbacks: [],
      setTitle(title) {
        item.title = title;
        return item;
      },
      setIcon(icon) {
        item.icon = icon;
        return item;
      },
      onClick(cb) {
        item.onClickCallbacks.push(cb);
        return item;
      },
    };
    builder(item);
    this.items.push(item);
    return this;
  }

  showAtMouseEvent(evt: unknown): void {
    this.shown = true;
    this.shownAt = evt;
  }
}

// ---------------------------------------------------------------------------
// WorkspaceLeaf + ItemView — Phase 9 addition (T9.1)
// ---------------------------------------------------------------------------
// Minimal stubs matching the Obsidian API surface used by BackupBrowserView.
// WorkspaceLeaf is the container the view is mounted into. ItemView is the
// base class for panel/tab views.

export class WorkspaceLeaf {
  /** The view currently occupying this leaf (set by ItemView). */
  view: unknown = null;
}

export interface ViewStateResult {}

export abstract class ItemView {
  app: App;
  leaf: WorkspaceLeaf;
  /** The container element tests can inspect. */
  containerEl: MockEl;
  /** The content-area element (subset of containerEl). */
  contentEl: MockEl;
  /** Child components registered via addChild. */
  protected _children: Component[] = [];

  constructor(leaf: WorkspaceLeaf) {
    this.leaf = leaf;
    // ItemView needs an App — we create one here for tests.
    // Production subclasses receive it via the leaf (leaf.view.app), but tests
    // that want to control the App should pass it in via BackupBrowserDeps.
    this.app = new App();
    this.containerEl = makeMockEl('div');
    this.contentEl = makeMockEl('div');
    this.containerEl.children.push(this.contentEl);
  }

  addChild(c: Component): void {
    this._children.push(c);
  }

  removeChild(c: Component): void {
    this._children = this._children.filter((ch) => ch !== c);
  }

  abstract getViewType(): string;
  abstract getDisplayText(): string;

  getIcon(): string {
    return 'archive-restore';
  }

  abstract onOpen(): Promise<void>;
  abstract onClose(): Promise<void>;

  /** Test helper: trigger open. */
  async _open(): Promise<void> {
    await this.onOpen();
  }

  /** Test helper: trigger close. */
  async _close(): Promise<void> {
    await this.onClose();
  }
}

// ---------------------------------------------------------------------------
// requestUrl (Phase 3 addition)
// ---------------------------------------------------------------------------
// Default no-network stub. Tests that exercise OAuth / HTTP paths inject their
// own transport; this just prevents "requestUrl is not a function" crashes if
// a module is imported that reaches for the symbol at load time.

export async function requestUrl(_arg: unknown): Promise<{
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  json: unknown;
  text: string;
}> {
  return {
    status: 200,
    headers: {},
    arrayBuffer: new ArrayBuffer(0),
    json: null,
    text: '',
  };
}

// ---------------------------------------------------------------------------
// Component — Phase 9 addition (T9.4)
// ---------------------------------------------------------------------------
// Minimal lifecycle stub matching the Obsidian Component interface.
// renderPreview registers child components against a Component for auto-disposal.

export class Component {
  private _children: Component[] = [];
  /** Test introspection: was unload() called? */
  _unloaded = false;

  addChild(c: Component): void {
    this._children.push(c);
  }

  removeChild(c: Component): void {
    this._children = this._children.filter((ch) => ch !== c);
  }

  load(): void {}
  unload(): void {
    this._unloaded = true;
    for (const child of this._children) child.unload();
    this._children = [];
  }
}

// ---------------------------------------------------------------------------
// MarkdownRenderer — Phase 9 addition (T9.4)
// ---------------------------------------------------------------------------
// Security-safe mock: walks content looking for <script>, javascript:, and
// onerror= patterns and inserts them as TEXT nodes, never as HTML — simulating
// Obsidian's DOMPurify-based rendering behaviour.
// Tests can inspect el.textContent to verify malicious content was not executed.

const DANGEROUS_PATTERNS = [/<script/gi, /javascript:/gi, /onerror=/gi];

export class MarkdownRenderer {
  static async render(
    _app: unknown,
    content: string,
    el: MockEl,
    _sourcePath: string,
    _component: Component,
  ): Promise<void> {
    // Strip or neutralise dangerous patterns by inserting as plain text.
    const sanitized = DANGEROUS_PATTERNS.reduce(
      (s, re) => s.replace(re, (match) => `[blocked:${match}]`),
      content,
    );
    el.createEl('div', { text: sanitized });
  }
}

// MarkdownRenderChild — minimal stub used by views that own a Component
// scope for renderPreview. The real implementation extends Component and
// is constructed with a host element; the mock only needs to be newable
// and to satisfy the Component contract (load/unload no-ops).
export class MarkdownRenderChild extends Component {
  containerEl: MockEl;
  constructor(containerEl: MockEl) {
    super();
    this.containerEl = containerEl;
  }
}
