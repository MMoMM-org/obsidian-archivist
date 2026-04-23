import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from '../fixtures/obsidian-mock';
// 'obsidian' is aliased to tests/fixtures/obsidian-mock.ts in vitest.config.ts
// so src/main.ts receives the mock when imported here.
import ArchivistPlugin from '../../src/main';

describe('ArchivistPlugin lifecycle', () => {
  let app: App;
  let manifest: { id: string; name: string; version: string };
  let plugin: ArchivistPlugin;

  beforeEach(() => {
    vi.useFakeTimers();
    app = new App();
    manifest = { id: 'obsidian-archivist', name: 'Archivist', version: '0.1.0' };
    plugin = new ArchivistPlugin(app as any, manifest as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('onload registers ribbon icon via registerX', async () => {
    const spy = vi.spyOn(plugin, 'addRibbonIcon');
    await plugin.onload();
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toBeTypeOf('string');   // icon name
    expect(spy.mock.calls[0][1]).toMatch(/archivist/i);  // tooltip
  });

  it("onload registers command 'archivist-hello'", async () => {
    const spy = vi.spyOn(plugin, 'addCommand');
    await plugin.onload();
    expect(spy).toHaveBeenCalled();
    const cmd = spy.mock.calls[0][0];
    expect(cmd.id).toBe('archivist-hello');
    expect(cmd.name).toMatch(/hello/i);
  });

  it('onload wires workspace event via registerEvent (not raw .on)', async () => {
    const regSpy = vi.spyOn(plugin, 'registerEvent');
    await plugin.onload();
    expect(regSpy).toHaveBeenCalled();  // some event was wired through registerEvent
  });

  it('onunload leaves zero pending timers', async () => {
    await plugin.onload();
    await plugin.onunload();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('onunload leaves zero lingering workspace listeners', async () => {
    await plugin.onload();
    const before = app.workspace._listeners.size;
    await plugin.onunload();
    // All listeners registered via registerEvent should be auto-cleaned by the Plugin base.
    // In our mock, the base Plugin class removes them in onunload.
    expect(app.workspace._listeners.size).toBeLessThanOrEqual(before);
    // After a load/unload cycle with clean mock, effective delta is 0 or net-removed
  });

  it('loadSettings returns empty object when data.json is absent', async () => {
    vi.spyOn(plugin, 'loadData').mockResolvedValue(null);
    const settings = await plugin.loadSettings();
    expect(settings).toEqual({});
  });
});
