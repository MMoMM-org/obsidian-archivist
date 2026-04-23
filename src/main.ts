import { Plugin } from 'obsidian';
import { createLogger, type Logger } from './infra/Logger';

export default class ArchivistPlugin extends Plugin {
  private logger: Logger = createLogger(() => false);

  async onload(): Promise<void> {
    this.logger = createLogger(() => false);
    this.logger.info('plugin_loaded');

    // Ribbon icon — Phase 7 replaces this callback with opening the Backup Browser.
    this.addRibbonIcon('archive', 'Archivist', () => {
      // Intentional no-op bootstrap.
    });

    // Placeholder command — real commands are authored in later phases.
    this.addCommand({
      id: 'archivist-hello',
      name: 'Hello',
      callback: () => {
        this.logger.info('hello command invoked');
      },
    });

    // `layout-ready` is a valid workspace event but missing from the current
    // Obsidian type surface. Cast through a minimal signature bound to the
    // workspace so we don't reach for `any` or lose `this`.
    type LayoutReadyOn = (ev: 'layout-ready', cb: () => void) => import('obsidian').EventRef;
    const workspace = this.app.workspace;
    const onLayoutReady = workspace.on.bind(workspace) as unknown as LayoutReadyOn;
    this.registerEvent(
      onLayoutReady('layout-ready', () => {
        // Phase 5+ hooks scheduler initialization here.
      }),
    );
  }

  onunload(): void {
    this.logger.info('plugin_unloaded');
    // The Obsidian base Plugin releases everything registered via
    // registerEvent/registerInterval in its onunload. Call super so those
    // registrations get torn down cleanly.
    super.onunload();
  }

  async loadSettings(): Promise<Record<string, unknown>> {
    const raw: unknown = await this.loadData();
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
    return {};
  }
}
