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
// Vault
// ---------------------------------------------------------------------------

export class Vault {
  adapter = {
    read: async (_path: string): Promise<string> => '',
    write: async (_path: string, _data: string): Promise<void> => {},
    exists: async (_path: string): Promise<boolean> => false,
    // Phase 3 addition: TokenStore.clear() calls adapter.remove to delete
    // tokens.json during OAuth disconnect.
    remove: async (_path: string): Promise<void> => {},
  };
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
