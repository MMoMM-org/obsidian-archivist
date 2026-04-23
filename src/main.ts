import { Plugin } from 'obsidian';

export default class ArchivistPlugin extends Plugin {
  async onload(): Promise<void> {
    // Minimal bootstrap log — full Logger module arrives in Phase 2.
    // The production build strips console.debug via esbuild drop:['debug'],
    // so log/warn/error survive for reasonable diagnostics.
    console.log('Archivist: plugin_loaded');

    // Ribbon icon (T1.4 bootstrap — real icon state machine is Phase 7).
    this.addRibbonIcon('archive', 'Archivist', () => {
      // Phase 7 will replace this with opening the Backup Browser.
    });

    // Hello command (T1.4 bootstrap — real commands authored in later phases).
    this.addCommand({
      id: 'archivist-hello',
      name: 'Archivist: Hello',
      callback: () => {
        console.log('Archivist: hello command invoked');
      },
    });

    // Gate any real work on layout-ready (guards against partial-vault 'create' events
    // fired by some Obsidian versions during initial indexing — see SDD Risks/Gotchas).
    this.registerEvent(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.app.workspace.on('layout-ready' as any, () => {
        // Phase 5+ will hook scheduler initialization here.
      }),
    );
  }

  async onunload(): Promise<void> {
    console.log('Archivist: plugin_unloaded');
    // Obsidian's Plugin base auto-cleans everything registered via this.registerX.
    // No manual teardown needed here.
  }

  async loadSettings(): Promise<Record<string, unknown>> {
    const raw = await this.loadData();
    return (raw as Record<string, unknown>) ?? {};
  }
}
