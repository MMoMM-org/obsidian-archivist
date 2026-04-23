import { Notice, Plugin } from 'obsidian';
import { TokenStore } from './infra/TokenStore';
import { createLogger, type Logger } from './infra/Logger';
import { OAuthConnectFlow, type OAuthCallbackParams } from './ui/OAuthConnectFlow';
import { S } from './ui/strings';

export default class ArchivistPlugin extends Plugin {
  private logger: Logger = createLogger(() => false);
  private oauthFlow: OAuthConnectFlow | null = null;

  async onload(): Promise<void> {
    this.logger = createLogger(() => false);
    this.logger.info('plugin_loaded');

    // OAuth flow bootstrap — real UI wiring arrives in Phase 7; for now we
    // register the protocol handler so Dropbox-browser callbacks land cleanly.
    const tokenStore = new TokenStore(this, this.logger);
    this.oauthFlow = new OAuthConnectFlow({ tokenStore, logger: this.logger });
    this.registerObsidianProtocolHandler('archivist-oauth', async (params) => {
      try {
        await this.oauthFlow!.handleCallback(params as unknown as OAuthCallbackParams);
        new Notice(S.OAUTH_CONNECTED_AS(''));
      } catch (err) {
        this.logger.error('oauth_callback_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        new Notice(S.OAUTH_STATE_MISMATCH);
      }
    });

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
    // Drop any in-flight PKCE state so a reload can't re-use it (SEC-H1).
    this.oauthFlow?.clearPending();
    this.oauthFlow = null;
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
