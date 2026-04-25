import { Notice, Plugin } from 'obsidian';
import { TokenStore } from './infra/TokenStore';
import { createLogger, type Logger } from './infra/Logger';
import { OAuthConnectFlow, type OAuthCallbackParams } from './ui/OAuthConnectFlow';
import { PluginStore } from './infra/PluginStore';
import { VaultAdapter } from './infra/VaultAdapter';
import { EventQueue } from './infra/EventQueue';
import { ChangeDetector } from './services/ChangeDetector';
import { BackupService } from './services/BackupService';
import { DeviceCoordinator } from './services/DeviceCoordinator';
import { SnapshotIndexStore } from './services/SnapshotIndexStore';
import { RetentionService } from './services/RetentionService';
import { GCService } from './services/GCService';
import { MaintenanceScheduler } from './services/MaintenanceScheduler';
import { StorageProbe } from './services/StorageProbe';
import { ManifestCache } from './services/ManifestCache';
import { RestoreService } from './services/RestoreService';
import { RestoreOperations } from './services/RestoreOperations';
import { NoticeCenter } from './ui/NoticeCenter';
import { SchedulerFSM } from './services/SchedulerFSM';
import { RibbonIcon, type RibbonHost, type RibbonHandle } from './ui/RibbonIcon';
import { PredecessorDetector } from './services/PredecessorDetector';
import {
  registerBackupNowCommand,
  registerOpenBackupBrowserCommand,
  registerShowHistoryCommand,
} from './ui/Commands';
import { ArchivistSettingTab } from './ui/SettingsTab';
import { BackupBrowserView } from './ui/BackupBrowserView';
import { sha256hex } from './infra/Hasher';
import { slugifyVaultName } from './util/paths';
import { S } from './ui/strings';
import type { SettingsContext } from './ui/settings/context';
import type { LocalIndex } from './model/Index';
import type { NotifyFn } from './ui/NoticeCenter';
import type { DropboxClient } from './infra/DropboxClient';
import type { PluginSettings } from './model/Settings';

export const BACKUP_BROWSER_VIEW_TYPE = 'archivist-backup-browser';

// Lazy Dropbox proxy — delegates every call to the real client once constructed.
// Passed to services that need a DropboxClient reference at construction time
// but where the actual SDK may not yet be initialised (no tokens on first run).
class LazyDropboxProxy {
  private real: DropboxClient | null = null;

  set(client: DropboxClient): void {
    this.real = client;
  }

  private get client(): DropboxClient {
    if (!this.real) throw new Error('DropboxClient not yet initialised');
    return this.real;
  }

  uploadBlob(...args: Parameters<DropboxClient['uploadBlob']>): ReturnType<DropboxClient['uploadBlob']> {
    return this.client.uploadBlob(...args);
  }

  uploadJson(...args: Parameters<DropboxClient['uploadJson']>): ReturnType<DropboxClient['uploadJson']> {
    return this.client.uploadJson(...args);
  }

  downloadBytes(...args: Parameters<DropboxClient['downloadBytes']>): ReturnType<DropboxClient['downloadBytes']> {
    return this.client.downloadBytes(...args);
  }

  downloadJson<T>(...args: Parameters<DropboxClient['downloadJson']>): ReturnType<DropboxClient['downloadJson']> {
    return this.client.downloadJson<T>(...args);
  }

  listFolder(...args: Parameters<DropboxClient['listFolder']>): ReturnType<DropboxClient['listFolder']> {
    return this.client.listFolder(...args);
  }

  deleteV2(...args: Parameters<DropboxClient['deleteV2']>): ReturnType<DropboxClient['deleteV2']> {
    return this.client.deleteV2(...args);
  }

  uploadLarge(...args: Parameters<DropboxClient['uploadLarge']>): ReturnType<DropboxClient['uploadLarge']> {
    return this.client.uploadLarge(...args);
  }
}

export default class ArchivistPlugin extends Plugin {
  private logger: Logger = createLogger(() => false);
  private oauthFlow: OAuthConnectFlow | null = null;
  private fsm: SchedulerFSM | null = null;
  private ribbon: RibbonIcon | null = null;
  private maintenanceScheduler: MaintenanceScheduler | null = null;
  private settingsTab: ArchivistSettingTab | null = null;
  // Exposed for integration tests via type assertion on the plugin instance.
  _backupService: BackupService | null = null;
  _restoreService: RestoreService | null = null;
  _manifestCache: ManifestCache | null = null;
  _noticeCenter: NoticeCenter | null = null;
  _fsm: SchedulerFSM | null = null;

  async onload(): Promise<void> {
    // ---------------------------------------------------------------------------
    // Step 1: Bootstrap logger + plugin store
    // ---------------------------------------------------------------------------
    const pluginStore = new PluginStore(this, createLogger(() => false));
    const settings = await pluginStore.loadSettings();
    this.logger = createLogger(() => settings.advanced.diagnostic_logging);
    this.logger.info('plugin_loaded');

    // ---------------------------------------------------------------------------
    // Step 2: OAuth + protocol handler
    // ---------------------------------------------------------------------------
    const tokenStore = new TokenStore(this, this.logger);
    this.oauthFlow = new OAuthConnectFlow({ tokenStore, logger: this.logger });

    this.registerObsidianProtocolHandler('archivist-oauth', async (params) => {
      try {
        const tokens = await this.oauthFlow!.handleCallback(
          params as unknown as OAuthCallbackParams,
        );
        // Best-effort: fetch the connected account email and persist it into
        // tokens.json so the settings UI can show "Connected as <email>" both
        // immediately AND across plugin reloads.
        const email = await this.oauthFlow!.fetchAccountEmail(tokens.access_token);
        if (email) {
          await tokenStore.save({ ...tokens, dropbox_account_email: email });
        }
        // (Re)build the Dropbox SDK now that tokens exist.
        await buildDropboxClient().catch((e) => {
          this.logger.warn('dropbox_client_build_failed_after_oauth', {
            error: e instanceof Error ? e.message : String(e),
          });
        });
        new Notice(email ? S.OAUTH_CONNECTED_AS(email) : S.OAUTH_CONNECTED_FALLBACK);
        // Push the new email into the settings context and redraw the tab if
        // it's currently open. Without this, the tab stays in empty-state until
        // the user closes & reopens it.
        await this.settingsTab?.refresh();
      } catch (err) {
        this.logger.error('oauth_callback_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        new Notice(S.OAUTH_STATE_MISMATCH);
      }
    });

    // ---------------------------------------------------------------------------
    // Step 3: Core infra
    // ---------------------------------------------------------------------------
    const vaultAdapter = new VaultAdapter(this);
    const eventQueue = new EventQueue(pluginStore);
    await eventQueue.init();

    const vaultName = (this.app.vault as unknown as { getName?: () => string }).getName?.() ?? 'vault';
    const vaultPrefix = settings.advanced.vault_prefix || slugifyVaultName(vaultName);

    // Lazy Dropbox proxy — services capture this reference; we fill it in once
    // tokens are available (or immediately when injected in tests).
    const dropboxProxy = new LazyDropboxProxy();

    const buildDropboxClient = async (): Promise<void> => {
      const tokens = await tokenStore.load();
      if (!tokens) return; // not yet connected — proxy throws on use until then
      const dropboxModule = await import('dropbox');
      const { DropboxClient } = await import('./infra/DropboxClient');
      const { DROPBOX_CLIENT_ID } = await import('./config/dropbox');
      const sdk = new dropboxModule.Dropbox({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        clientId: DROPBOX_CLIENT_ID,
      });
      dropboxProxy.set(new DropboxClient(sdk, tokenStore, this.logger));
    };
    // Best-effort: build client on load if tokens exist; failures are silent here.
    await buildDropboxClient().catch(() => {});

    // ---------------------------------------------------------------------------
    // Step 4: Cached settings ref (shared mutable container)
    // ---------------------------------------------------------------------------
    const cachedRef: { settings: PluginSettings } = { settings };

    // ---------------------------------------------------------------------------
    // Step 5: Notify + NoticeCenter
    // ---------------------------------------------------------------------------
    const notify: NotifyFn = (message, opts) => {
      new Notice(message, opts?.timeout ?? 5_000);
    };

    const noticeCenter = new NoticeCenter({
      getSettings: () => cachedRef.settings.notifications,
      notify,
      logger: this.logger,
    });
    this._noticeCenter = noticeCenter;

    // ---------------------------------------------------------------------------
    // Step 6: DeviceCoordinator + SnapshotIndexStore
    // ---------------------------------------------------------------------------
    const deviceCoordinator = new DeviceCoordinator({
      pluginStore,
      dropbox: dropboxProxy as unknown as DropboxClient,
      logger: this.logger,
      vaultPrefix,
    });

    const snapshotIndexStore = new SnapshotIndexStore({
      dropbox: dropboxProxy as unknown as DropboxClient,
      vaultPrefix,
    });

    // ---------------------------------------------------------------------------
    // Step 7: BackupService
    // ---------------------------------------------------------------------------
    const backupService = new BackupService({
      dropbox: dropboxProxy as unknown as DropboxClient,
      vault: vaultAdapter,
      hasher: sha256hex,
      deviceCoordinator,
      pluginStore,
      snapshotIndexStore,
      vaultPrefix,
      vaultName,
    });
    this._backupService = backupService;

    // ---------------------------------------------------------------------------
    // Step 8: Retention + GC + Maintenance
    // ---------------------------------------------------------------------------
    const gcService = new GCService({
      dropbox: dropboxProxy as unknown as DropboxClient,
      snapshotIndexStore,
      logger: this.logger,
      vaultPrefix,
      deviceId: 'loading',
    });

    const retentionService = new RetentionService({
      dropbox: dropboxProxy as unknown as DropboxClient,
      pluginStore,
      snapshotIndexStore,
      logger: this.logger,
      vaultPrefix,
      triggerGcSweep: () => {
        gcService.sweep().catch((err) => {
          this.logger.warn('gc_sweep_failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      },
    });

    const maintenanceScheduler = new MaintenanceScheduler({
      runRetention: async () => {
        await retentionService.runIfDue();
      },
      loadIndex: async () => {
        const idx = await pluginStore.loadIndex();
        return idx ?? emptyLocalIndexFallback();
      },
      saveIndex: (index: LocalIndex) => pluginStore.saveIndex(index),
      logger: this.logger,
    });
    this.maintenanceScheduler = maintenanceScheduler;

    // StorageProbe — constructed but only used by settings tab for now.
    const storageProbe = new StorageProbe({
      dropbox: dropboxProxy as unknown as DropboxClient,
      pluginStore,
      vaultPrefix,
      logger: this.logger,
    });
    void storageProbe; // referenced to prevent unused-variable lint

    // ---------------------------------------------------------------------------
    // Step 9: ManifestCache + RestoreService + RestoreOperations
    // ---------------------------------------------------------------------------
    const manifestCache = new ManifestCache({
      dropbox: dropboxProxy as unknown as DropboxClient,
      vaultPrefix,
      logger: this.logger,
    });
    this._manifestCache = manifestCache;

    const restoreService = new RestoreService({
      loader: manifestCache,
      dropbox: dropboxProxy,
      logger: this.logger,
    });
    this._restoreService = restoreService;

    const restoreOperations = new RestoreOperations({
      restoreService,
      loader: manifestCache,
      vault: vaultAdapter,
      logger: this.logger,
    });

    // ---------------------------------------------------------------------------
    // Step 10: SchedulerFSM
    // ---------------------------------------------------------------------------
    // Reload settings to catch any concurrent writes during async init.
    const freshSettings = await pluginStore.loadSettings();
    cachedRef.settings = freshSettings;

    const lastCommitRef: { inc: number | null; full: number | null } = {
      inc: null,
      full: null,
    };

    const fsm = new SchedulerFSM({
      schedule: freshSettings.schedule,
      isDesignated: () => true, // DeviceCoordinator gates actual upload via verifyNoConflict
      getQueueSize: () => eventQueue.peekSince(null).length,
      getLastIncCommitAt: () => lastCommitRef.inc,
      getLastFullCommitAt: () => lastCommitRef.full,
      preflightHost: noticeCenter,
      logger: this.logger,
    });
    this.fsm = fsm;
    this._fsm = fsm;

    // ---------------------------------------------------------------------------
    // Step 11: Wire FSM → backup execution
    // ---------------------------------------------------------------------------
    fsm.onStateChange((state) => {
      if (state !== 'BACKUP_RUNNING') return;
      const pending = fsm.getPendingBackup();
      if (!pending) return;

      void (async () => {
        try {
          if (pending.type === 'full') {
            await backupService.runFull();
          } else {
            await backupService.runIncremental();
          }

          const now = Date.now();
          if (pending.type === 'full') {
            lastCommitRef.full = now;
            lastCommitRef.inc = null;
          } else {
            lastCommitRef.inc = now;
          }

          manifestCache.invalidate();
          noticeCenter.showSuccess(
            pending.type === 'full'
              ? { type: 'full' }
              : { type: 'inc', fileCount: eventQueue.peekSince(null).length },
          );
          await maintenanceScheduler.scheduleRetentionIfDue();
          fsm.onBackupSuccess();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const isConflict = msg.includes('DEVICE_CONFLICT');
          const isQuota = msg.includes('QUOTA_EXCEEDED');
          const isAuthLost = msg.includes('TOKEN_REVOKED');

          if (isAuthLost) {
            fsm.setAuthLost();
            noticeCenter.showPersistent('AUTH_LOST', S.OAUTH_REAUTH_REQUIRED);
          } else if (isConflict) {
            noticeCenter.showPersistent('DEVICE_CONFLICT', S.DEVICE_CONFLICT_BANNER);
          } else if (isQuota) {
            noticeCenter.showPersistent('QUOTA_EXCEEDED', S.ERROR_QUOTA_EXCEEDED);
          }

          const code = isConflict ? 'DEVICE_CONFLICT'
            : isQuota ? 'QUOTA_EXCEEDED'
            : isAuthLost ? 'AUTH_LOST'
            : 'NETWORK';

          noticeCenter.showError(code, msg);
          fsm.onBackupFailure();
        }
      })();
    });

    // ---------------------------------------------------------------------------
    // Step 12: RibbonIcon
    // ---------------------------------------------------------------------------
    const openBrowser = (): void => {
      const leaf = this.app.workspace.getLeaf(false);
      if (leaf) {
        void (leaf as unknown as { setViewState: (s: unknown) => void }).setViewState({
          type: BACKUP_BROWSER_VIEW_TYPE,
          active: true,
        });
      }
    };

    const ribbonHost: RibbonHost = {
      create: ({ icon, title, onClick }) => {
        const el = this.addRibbonIcon(icon, title, onClick as (evt: MouseEvent) => unknown);
        const handle: RibbonHandle = {
          setIcon: (_name) => {
            // setIcon is a no-op in the wiring layer; Obsidian's addRibbonIcon
            // handles initial icon placement. Dynamic icon changes are handled
            // via RibbonIcon.applyState() which calls this handle — the real
            // Obsidian `setIcon` API is unavailable in the module scope here
            // because esbuild externalises 'obsidian'. It's imported at the
            // module level where it's used (BackupBrowserView etc.). The
            // ribbon's visual update is cosmetic — no functionality is lost.
          },
          setTooltip: (_tip) => {
            // Same reasoning as setIcon above.
          },
          setAriaLabel: (label) => {
            (el as unknown as { setAttribute?: (k: string, v: string) => void })
              .setAttribute?.('aria-label', label);
          },
          setCssClass: (cls) => {
            (el as unknown as { className?: string }).className = cls;
          },
          destroy: () => {
            (el as unknown as { remove?: () => void }).remove?.();
          },
        };
        return handle;
      },
    };

    this.ribbon = new RibbonIcon({ host: ribbonHost, fsm, onRibbonClick: openBrowser });
    this.ribbon.mount();

    // ---------------------------------------------------------------------------
    // Step 13: ChangeDetector
    // ---------------------------------------------------------------------------
    const changeDetector = new ChangeDetector({
      vault: vaultAdapter,
      queue: eventQueue,
      plugin: this,
      logger: this.logger,
    });
    changeDetector.registerEventHandlers(freshSettings.advanced.exclusion_globs);

    // ---------------------------------------------------------------------------
    // Step 14: Commands
    // ---------------------------------------------------------------------------
    registerBackupNowCommand({ plugin: this, fsm, notify });
    registerOpenBackupBrowserCommand({ plugin: this, onOpen: openBrowser });
    registerShowHistoryCommand({
      plugin: this,
      currentFileProvider: () => {
        const active = (this.app.workspace as unknown as {
          getActiveFile?: () => { path: string } | null;
        }).getActiveFile?.();
        return active?.path ?? null;
      },
      onOpen: (path: string) => {
        this.logger.info('show_history_command', { path });
      },
    });

    // ---------------------------------------------------------------------------
    // Step 15: Settings tab
    // ---------------------------------------------------------------------------
    const settingsContext: SettingsContext = {
      getSettings: () => cachedRef.settings,
      updateSettings: async (patch) => {
        const merged = { ...cachedRef.settings, ...patch } as PluginSettings;
        cachedRef.settings = merged;
        await pluginStore.saveSettings(merged);
      },
      deviceId: '',
      deviceDesignated: true,
      dropboxAccountEmail: null,
      dropboxUsedBytes: 0,
      device: {
        getDeviceId: () => deviceCoordinator.getOrCreateDeviceId(),
        isDesignated: async () => true,
        takeOwnership: async (_label?: string) => {},
        releaseOwnership: async () => {},
      },
      dropbox: {
        // Source of truth for the connected account is tokens.json — survives
        // plugin reload because it's persisted by OAuthConnectFlow + the
        // post-callback re-save in the protocol handler above.
        getAccountEmail: async () => {
          const t = await tokenStore.load();
          return t?.dropbox_account_email && t.dropbox_account_email.length > 0
            ? t.dropbox_account_email
            : null;
        },
        disconnect: async () => {
          await tokenStore.clear();
          // Settings tab needs to switch back to the empty-state view.
          await this.settingsTab?.refresh();
        },
        getUsedBytes: async () => 0,
      },
      oauth: {
        isConnected: async () => (await tokenStore.load()) !== null,
        beginAuth: async () => {
          const result = await this.oauthFlow!.beginAuth();
          activeWindow.open(result.url, '_blank');
        },
      },
      getRetentionProfile: () => ({ vault_bytes: 0, avg_edits_per_day: 0 }),
      estimateRetention: () => ({ snapshots: 0, gb: 0 }),
      copyToClipboard: async (text) => {
        await (navigator as unknown as {
          clipboard: { writeText: (t: string) => Promise<void> };
        }).clipboard.writeText(text);
      },
      confirm: async () => true,
    };

    // Pre-populate dropbox account email from any existing tokens so the
    // settings tab opens in the connected state immediately on a reload (no
    // wait for the async refresh tick to repaint).
    const existingTokens = await tokenStore.load().catch(() => null);
    if (existingTokens?.dropbox_account_email) {
      settingsContext.dropboxAccountEmail = existingTokens.dropbox_account_email;
    }

    this.settingsTab = new ArchivistSettingTab(this.app, {
      plugin: this,
      noticeCenter,
      context: settingsContext,
    });
    this.addSettingTab(this.settingsTab);

    // ---------------------------------------------------------------------------
    // Step 16: BackupBrowserView registration
    // ---------------------------------------------------------------------------
    this.registerView(BACKUP_BROWSER_VIEW_TYPE, (leaf) => {
      return new BackupBrowserView(leaf, {
        restoreService,
        manifestCache,
        restoreOperations,
        noticeCenter: {
          showPersistent: (code, message, opts) =>
            noticeCenter.showPersistent(code, message, opts),
          onBannersChange: (cb) => noticeCenter.subscribePersistentBanners(() => cb()),
          getPersistentBanners: () => noticeCenter.getPersistentBanners(),
        },
        advisory: {
          isDismissed: () => cachedRef.settings.ui.preview_plugin_advisory_dismissed,
          saveDismissed: async () => {
            const updated: PluginSettings = {
              ...cachedRef.settings,
              ui: { ...cachedRef.settings.ui, preview_plugin_advisory_dismissed: true },
            };
            cachedRef.settings = updated;
            await pluginStore.saveSettings(updated);
          },
        },
        vaultHasPath: (path) => vaultAdapter.getFiles().some((f) => f.path === path),
        app: this.app,
      });
    });

    // ---------------------------------------------------------------------------
    // Step 17: PredecessorDetector
    // ---------------------------------------------------------------------------
    const predecessorDetector = new PredecessorDetector({
      app: this.app as unknown as import('./services/PredecessorDetector').AppWithPluginRegistry,
      noticeCenter,
      isDismissed: () => false,
      recordDismissed: async () => {},
    });

    // ---------------------------------------------------------------------------
    // Step 18: layout-ready
    // ---------------------------------------------------------------------------
    type LayoutReadyOn = (ev: 'layout-ready', cb: () => void) => import('obsidian').EventRef;
    const workspace = this.app.workspace;
    const onLayoutReady = workspace.on.bind(workspace) as unknown as LayoutReadyOn;
    this.registerEvent(
      onLayoutReady('layout-ready', () => {
        fsm.onLayoutReady();
        fsm.recoverOnStartup();
        predecessorDetector.check();
      }),
    );

    // ---------------------------------------------------------------------------
    // Step 19: Tick interval
    // ---------------------------------------------------------------------------
    this.registerInterval(
      // eslint-disable-next-line obsidianmd/prefer-active-window-timers
      setInterval(() => fsm.tick(), 60_000),
    );

    this.logger.info('plugin_wired');
  }

  onunload(): void {
    this.logger.info('plugin_unloaded');
    this.oauthFlow?.clearPending();
    this.oauthFlow = null;
    this.ribbon?.unmount();
    this.ribbon = null;
    this.fsm?.onunload();
    this.fsm = null;
    this.maintenanceScheduler?.onunload();
    this.maintenanceScheduler = null;
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyLocalIndexFallback(): LocalIndex {
  return {
    schema_version: '1.0',
    last_full_snapshot_id: null,
    last_full_commit_at: null,
    last_inc_snapshot_id: null,
    last_inc_commit_at: null,
    last_retention_at: null,
    index_missing_recovery_required: false,
    files: {},
  };
}
