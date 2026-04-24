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

  /** Register a TFile and seed its binary content. */
  _addFile(path: string, stat: { mtime: number; size: number }): TFile {
    const file = new TFile(path, stat);
    this._files.push(file);
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
    return {} as HTMLElement;
  }

  addCommand(command: Command): Command {
    return command;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  addSettingTab(_tab: unknown): void {}

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
