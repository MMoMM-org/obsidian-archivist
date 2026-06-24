import { Notice, Plugin, setIcon } from 'obsidian';
import { TokenStore } from './infra/TokenStore';
import { migrateLegacyTokensIfPresent } from './infra/LegacyTokenMigration';
import { createLogger, type Logger } from './infra/Logger';
import { OAuthConnectFlow, type OAuthCallbackParams } from './ui/OAuthConnectFlow';
import { PluginStore } from './infra/PluginStore';
import { VaultAdapter } from './infra/VaultAdapter';
import { EventQueue } from './infra/EventQueue';
import { ChangeDetector } from './services/ChangeDetector';
import { BackupService } from './services/BackupService';
import { createBackupProgressTracker } from './services/BackupProgress';
import { DeviceCoordinator } from './services/DeviceCoordinator';
import { SnapshotIndexStore } from './services/SnapshotIndexStore';
import { RetentionService } from './services/RetentionService';
import { GCService } from './services/GCService';
import { RepairService } from './services/RepairService';
import { VaultIdentity } from './services/VaultIdentity';
import { AdoptVaultModal } from './ui/AdoptVaultModal';
import { ErrorDetailsModal, type ErrorDetailsRecord } from './ui/ErrorDetailsModal';
import { MaintenanceScheduler } from './services/MaintenanceScheduler';
import { StorageProbe } from './services/StorageProbe';
import { ManifestCache } from './services/ManifestCache';
import { RestoreService } from './services/RestoreService';
import { RestoreOperations } from './services/RestoreOperations';
import { NoticeCenter } from './ui/NoticeCenter';
import { SchedulerFSM } from './services/SchedulerFSM';
import { RibbonIcon, type RibbonHost, type RibbonHandle } from './ui/RibbonIcon';
import { StatusBar, type StatusBarHost, type StatusBarHandle } from './ui/StatusBar';
import { PredecessorDetector } from './services/PredecessorDetector';
import {
  registerBackupNowCommand,
  registerOpenBackupBrowserCommand,
  registerShowHistoryCommand,
  registerRepairCommands,
  registerRetentionCommands,
  registerVerifyVaultOwnershipCommand,
} from './ui/Commands';
import { ArchivistSettingTab } from './ui/SettingsTab';
import { BackupBrowserView, BACKUP_BROWSER_VIEW_TYPE } from './ui/BackupBrowserView';
import { FileHistoryModal } from './ui/FileHistoryModal';
import { FileVersionsView, FILE_VERSIONS_VIEW_TYPE } from './ui/FileVersionsView';
import { sha256hex } from './infra/Hasher';
import { slugifyVaultName } from './util/paths';
import { epochMsFromSnapshotId } from './util/time';
import { S } from './ui/strings';
import type { SettingsContext } from './ui/settings/context';
import type { LocalIndex } from './model/Index';
import type { NotifyFn } from './ui/NoticeCenter';
import type { DropboxClient } from './infra/DropboxClient';
import type { PluginSettings } from './model/Settings';
import { ConfigError } from './model/Errors';
import { MismatchRecoveryModal } from './ui/MismatchRecoveryModal';
import type { BlockReason } from './services/SchedulerFSM';

// BACKUP_BROWSER_VIEW_TYPE is the canonical export from BackupBrowserView.
// It is re-exported here so existing importers (`@/main`) keep working.
export { BACKUP_BROWSER_VIEW_TYPE };

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

/**
 * Map ConfigError.code values to FSM BlockReason. Only codes that
 * should freeze the backup loop are returned; everything else returns
 * null so the caller falls through to the transient-error path.
 *
 * SCHEMA_INVALID (configInvalid helper) is intentionally excluded —
 * those originate from data shapes downstream of vault identity and
 * are typically programmer errors that warrant a hard failure rather
 * than a user-facing recovery flow.
 */
function configCodeToBlockReason(code: string): BlockReason | null {
  switch (code) {
    case 'VAULT_ID_MISMATCH':
      return 'VAULT_ID_MISMATCH';
    case 'VAULT_META_CORRUPT':
      return 'VAULT_META_CORRUPT';
    case 'VAULT_ID_NEEDS_ADOPTION':
      return 'VAULT_ID_NEEDS_ADOPTION';
    case 'VAULT_ID_INVALID':
      return 'VAULT_ID_INVALID';
    default:
      return null;
  }
}

/**
 * Prefix for every user-visible Obsidian Notice this plugin raises, so a user
 * running many plugins can attribute a toast (e.g. a network error) to Archivist
 * at a glance instead of guessing which plugin is reporting.
 */
const NOTICE_PREFIX = 'Archivist: ';

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
    // Mutable container so the logger's diagnostic-flag closure reflects
    // settings updates from the UI. Was previously capturing the initial
    // `settings` snapshot, which meant toggling the flag at runtime had no
    // effect — the closure kept seeing the old value forever.
    const cachedRef: { settings: PluginSettings } = { settings };
    this.logger = createLogger(() => cachedRef.settings.advanced.diagnostic_logging);
    this.logger.info('plugin_loaded');

    // ---------------------------------------------------------------------------
    // Step 2: OAuth + protocol handler
    // ---------------------------------------------------------------------------
    const tokenStore = new TokenStore(this, this.logger);
    // ADR-21: one-shot migration from legacy tokens.json into SecretStorage.
    // No-op on fresh installs; removed at target 0.9.0 per phase-13.
    await migrateLegacyTokensIfPresent(this, tokenStore, this.logger);
    this.oauthFlow = new OAuthConnectFlow({ tokenStore, logger: this.logger });

    this.registerObsidianProtocolHandler('archivist-oauth', async (params) => {
      try {
        const tokens = await this.oauthFlow!.handleCallback(
          params as unknown as OAuthCallbackParams,
        );
        // Best-effort: fetch the connected account email and persist it into
        // the secret store so the settings UI can show "Connected as <email>"
        // both immediately AND across plugin reloads.
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
        new Notice(`${NOTICE_PREFIX}${email ? S.OAUTH_CONNECTED_AS(email) : S.OAUTH_CONNECTED_FALLBACK}`);
        // Push the new email into the settings context and redraw the tab if
        // it's currently open. Without this, the tab stays in empty-state until
        // the user closes & reopens it.
        await this.settingsTab?.refresh();
      } catch (err) {
        this.logger.error('oauth_callback_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        new Notice(`${NOTICE_PREFIX}${S.OAUTH_STATE_MISMATCH}`);
      }
    });

    // ---------------------------------------------------------------------------
    // Step 3: Core infra
    // ---------------------------------------------------------------------------
    const vaultAdapter = new VaultAdapter(this);
    const eventQueue = new EventQueue(pluginStore);
    await eventQueue.init();

    // M7: O(1) vault-presence lookup for the Backup Browser / File-History
    // / file-menu callbacks. The Set is built lazily on first call and
    // invalidated whenever the vault gains, loses, or renames a file —
    // those are the only mutations that change the path set. `modify`
    // events are not invalidating.
    let vaultPathSet: Set<string> | null = null;
    const invalidateVaultPaths = (): void => { vaultPathSet = null; };
    const vaultHasPath = (path: string): boolean => {
      if (vaultPathSet === null) {
        vaultPathSet = new Set(vaultAdapter.getFiles().map((f) => f.path));
      }
      return vaultPathSet.has(path);
    };
    this.registerEvent(this.app.vault.on('create', invalidateVaultPaths));
    this.registerEvent(this.app.vault.on('delete', invalidateVaultPaths));
    this.registerEvent(this.app.vault.on('rename', invalidateVaultPaths));

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
      const { requestUrlFetch } = await import('./infra/requestUrlFetch');
      const sdk = new dropboxModule.Dropbox({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        clientId: DROPBOX_CLIENT_ID,
        // Route every SDK call through Obsidian's requestUrl to bypass CORS on
        // content.dropboxapi.com (see src/infra/requestUrlFetch.ts). Forwarded
        // into the SDK's internal DropboxAuth, so token refresh is covered too.
        fetch: requestUrlFetch,
      });
      dropboxProxy.set(new DropboxClient(sdk, tokenStore, this.logger));
    };
    // Best-effort: build client on load if tokens exist; failures are silent here.
    await buildDropboxClient().catch(() => {});

    // ---------------------------------------------------------------------------
    // Step 4: Cached settings ref (shared mutable container)
    // ---------------------------------------------------------------------------
    // Container is created in Step 1 (so the logger's diagnostic-flag closure
    // can read the live value); referenced here for the rest of the pipeline.

    // ---------------------------------------------------------------------------
    // Step 5: Notify + NoticeCenter
    // ---------------------------------------------------------------------------
    const notify: NotifyFn = (message, opts) => {
      const timeout = opts?.timeout ?? 5_000;
      const buttons = opts?.buttons ?? [];

      // Compose a DocumentFragment so we can attach buttons inline. The
      // Notice constructor accepts DocumentFragment as its first argument —
      // this avoids touching the deprecated `noticeEl` and the v1.8.7-only
      // `messageEl`, both of which the lint rules disallow at our current
      // minAppVersion. Each button click dismisses the notice before
      // invoking the handler, otherwise the sticky preflight would linger.
      const frag = createFragment();
      // Prefix every toast with the plugin name so a user with many plugins can
      // tell at a glance which one is reporting (e.g. a network error) rather
      // than guessing. Covers all NoticeCenter routes (success / error /
      // preflight / resumed) since they all render through this factory.
      frag.createDiv({ text: `${NOTICE_PREFIX}${message}` });
      const noticeRef: { current: Notice | null } = { current: null };
      if (buttons.length > 0) {
        const container = frag.createDiv({ cls: 'archivist-notice-actions' });
        for (const btn of buttons) {
          const el = container.createEl('button', { text: btn.label });
          el.addEventListener('click', () => {
            try {
              btn.onClick();
            } finally {
              noticeRef.current?.hide();
            }
          });
        }
      }

      const notice = new Notice(frag, timeout);
      noticeRef.current = notice;
      return { hide: () => notice.hide() };
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

    // VaultIdentity — vault-fingerprint guard. Generates a local UUID on
    // first plugin load, claims the Dropbox folder on first FULL, and
    // blocks backup writes when the IDs disagree. See
    // `docs/operations/connecting-existing-backup.md`.
    const vaultIdentity = new VaultIdentity({
      pluginStore,
      dropbox: dropboxProxy as unknown as DropboxClient,
      vaultPrefix,
      vaultName,
      logger: this.logger,
    });
    // Generate the local vault_id immediately so any subsequent code
    // (settings tab, backup invocations) sees a populated identity. The
    // remote consistency check runs once Dropbox is reachable — see the
    // onLayoutReady block below.
    await vaultIdentity.ensureLocalVaultId();

    // ---------------------------------------------------------------------------
    // Step 7: BackupService
    // ---------------------------------------------------------------------------
    // ChangeDetector is constructed early so BackupService can use it for the
    // startup reconcile pass. Live event handlers are still registered later
    // (Step 13) — that's a vault-event subscription side effect, separate
    // from the reconcileScan + getChangedPaths surfaces this dependency
    // exposes to BackupService.
    const changeDetector = new ChangeDetector({
      vault: vaultAdapter,
      queue: eventQueue,
      plugin: this,
      logger: this.logger,
    });

    // Live progress tracker — written by BackupService at phase boundaries
    // and per-batch advances; read by getTooltipInput so the status-bar
    // tooltip shows "Archivist — uploading 432/5988". The status bar
    // subscribes below to refresh on each (throttled) change.
    const progressTracker = createBackupProgressTracker();

    // Late-bound snapshot-index rebuilder. RepairService is built below (it
    // depends on GCService, also built below), but BackupService needs to
    // rebuild a corrupt index mid-commit and retry the append. The mutable
    // holder lets us wire the callback once RepairService exists without
    // forcing a circular construction order — same pattern as
    // manifestCacheInvalidator below.
    const indexRebuilder: { rebuild: (() => Promise<void>) | null } = { rebuild: null };

    const backupService = new BackupService({
      dropbox: dropboxProxy as unknown as DropboxClient,
      vault: vaultAdapter,
      hasher: sha256hex,
      deviceCoordinator,
      pluginStore,
      snapshotIndexStore,
      eventQueue,
      changeDetector,
      logger: this.logger,
      progress: progressTracker,
      // Self-heal a corrupt snapshot_index during commit: rebuild from the
      // authoritative manifests on Dropbox, then retry the append once.
      rebuildSnapshotIndex: () =>
        indexRebuilder.rebuild?.() ??
        Promise.reject(new Error('snapshot-index rebuilder not wired')),
      // Surface chain-walk corruption recovery as a persistent banner so a
      // long-running fall-back FULL doesn't look like the plugin hung. The
      // banner clears below in the BACKUP_RUNNING success/failure handlers.
      onChainCorruptionDetected: () => {
        noticeCenter.showPersistent('CHAIN_RECOVERY', S.CHAIN_RECOVERY_BANNER);
      },
      vaultIdentity,
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
      // L2: lazy resolver — sweep() pulls the real DeviceCoordinator UUID
      // when the lock is written, so the gc_lock's device_id field is the
      // diagnostic identifier rather than the placeholder it used to be.
      deviceId: () => deviceCoordinator.getOrCreateDeviceId(),
    });

    // Late-bound ManifestCache invalidator. ManifestCache is built below
    // (Step 9), but RetentionService and RepairService — both built here
    // before ManifestCache — need to flush the cache after they mutate the
    // snapshot index. The mutable holder lets us wire the callback once
    // ManifestCache exists without forcing a circular construction order.
    const manifestCacheInvalidator: { invalidate: (() => void) | null } = { invalidate: null };

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
      invalidateManifestCache: () => manifestCacheInvalidator.invalidate?.(),
    });

    // RepairService — user-triggerable recovery (rebuild snapshot_index +
    // manual GC + clear stale gc_lock). See
    // `docs/troubleshooting/dropbox-corruption.md`. The cache invalidator
    // is shared with RetentionService — both mutate the snapshot index and
    // need to flush ManifestCache so the Backup Browser sees the new state.
    const repairService = new RepairService({
      dropbox: dropboxProxy as unknown as DropboxClient,
      snapshotIndexStore,
      gcService,
      vaultPrefix,
      logger: this.logger,
      invalidateManifestCache: () => manifestCacheInvalidator.invalidate?.(),
    });

    // Wire the late-bound rebuilder now that RepairService exists, so a backup
    // can self-heal a corrupt snapshot_index (BackupService.appendToIndexWithSelfHeal).
    indexRebuilder.rebuild = () => repairService.rebuildSnapshotIndex().then(() => undefined);

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
    // Late-bind the manifest-cache invalidator now that ManifestCache
    // exists. Without this, RetentionService and RepairService can mutate
    // the on-Dropbox snapshot index but the Backup Browser keeps showing
    // the stale list (it reads from ManifestCache's in-process copy)
    // until the plugin reloads.
    manifestCacheInvalidator.invalidate = (): void => manifestCache.invalidate();

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

    // Hydrate from the persisted local index so the FSM sees prior backups
    // across plugin reloads. Without this every onload looks like a fresh
    // install (lastFull = null), and recoverOnStartup can't tell whether a
    // scheduled FULL was missed during the last shutdown window.
    //
    // Snapshot ids are minute-precision UTC timestamps (e.g.
    // '2026-04-26T03-00-full'); epochMsFromSnapshotId parses them back.
    const persistedIndex = await pluginStore.loadIndex();
    const lastCommitRef: { inc: number | null; full: number | null } = {
      inc: epochMsFromSnapshotId(persistedIndex?.last_inc_snapshot_id ?? null),
      full: epochMsFromSnapshotId(persistedIndex?.last_full_snapshot_id ?? null),
    };

    // Last backup failure — populated in the catch block below, consumed by
    // the status-bar click handler (ErrorDetailsModal). Keeping this in main
    // (not on the FSM) because it carries error semantics — code / message /
    // stack — that the FSM intentionally does not model. A single ref slot
    // is enough: when several errors occur in a row the latest one is the
    // one the user wants to act on.
    const lastErrorRef: { current: ErrorDetailsRecord | null } = { current: null };

    // Mismatch / corrupt-remote recovery record — populated when the FSM
    // enters BLOCKED so the status-bar click handler can open
    // MismatchRecoveryModal with both vault_ids on hand. Cleared by
    // clearBlock() and by a successful adopt.
    const mismatchRecordRef: {
      current: import('./ui/MismatchRecoveryModal').MismatchRecoveryRecord | null;
    } = { current: null };

    // Indirection so surfaceBlockingConfigError (defined here) can open the
    // recovery modal that is wired further down, after the status-bar surface
    // exists. Assigned once during onload; the probe / backup paths that call
    // surfaceBlockingConfigError all run after onload has finished wiring.
    let openRecovery: () => void = () => {};

    // The sticky "backups paused" Notice, kept so the toast can be hidden the
    // moment the condition is resolved (adopt success) instead of lingering.
    // `code` guards against stacking a duplicate when the same condition
    // surfaces twice (proactive probe + first backup tick).
    const blockingNotice: { handle: Notice | null; code: string | null } = {
      handle: null,
      code: null,
    };
    const clearBlockingNotice = (): void => {
      blockingNotice.handle?.hide();
      blockingNotice.handle = null;
      blockingNotice.code = null;
    };
    // A sticky (timeout 0) toast would outlive the plugin otherwise — drop it
    // on unload so disabling the plugin never leaves an orphaned notice.
    this.register(clearBlockingNotice);

    /**
     * Surface a blocking config error on every channel the user might be
     * looking at: a persistent banner with a Resolve action (Settings +
     * Backup Browser), a sticky clickable Notice (impossible to miss even
     * with Settings closed and the ribbon collapsed), and the lastError
     * snapshot for the "Copy report" button. The red status-bar / ribbon
     * icon is driven separately by the FSM BLOCKED state. Consumed both from
     * the catch block (mid-backup failure) and from the onLayoutReady probe
     * (proactive detection before the first backup attempt).
     */
    const surfaceBlockingConfigError = (
      reason: BlockReason,
      detail: string,
    ): void => {
      const bannerCode = reason === 'VAULT_META_CORRUPT'
        ? 'VAULT_META_CORRUPT'
        : 'VAULT_ID_MISMATCH';
      const bannerMessage = reason === 'VAULT_META_CORRUPT'
        ? S.REMOTE_CORRUPT_BANNER
        : S.MISMATCH_BANNER;
      noticeCenter.showPersistent(bannerCode, bannerMessage, {
        action: { label: S.MISMATCH_BANNER_RESOLVE, onClick: () => openRecovery() },
      });
      // Sticky, clickable toast — the signal the user was missing. Only one
      // per condition; re-surfacing the same code leaves the existing toast.
      if (blockingNotice.code !== bannerCode) {
        clearBlockingNotice();
        const notice = new Notice(`${NOTICE_PREFIX}${bannerMessage}`, 0);
        notice.messageEl.addClass('archivist-notice-clickable');
        this.registerDomEvent(notice.messageEl, 'click', () => openRecovery());
        blockingNotice.handle = notice;
        blockingNotice.code = bannerCode;
      }
      // Persist the detail for ErrorDetailsModal too — keeps the "Copy
      // report" button useful even before the user opens the recovery
      // modal.
      lastErrorRef.current = {
        code: reason,
        message: detail,
        stack: null,
        at: Date.now(),
        kind: 'inc',
      };
    };

    const fsm = new SchedulerFSM({
      schedule: freshSettings.schedule,
      isDesignated: () => true, // DeviceCoordinator gates actual upload via verifyNoConflict
      // Pending = events after committed_through. Using `null` as the cursor
      // counted ALL entries — including ones already in a committed snapshot —
      // and produced phantom inc triggers for an entire inc_interval after
      // every successful inc.
      getQueueSize: () => eventQueue.peekSince(eventQueue.committedThrough()).length,
      getLastIncCommitAt: () => lastCommitRef.inc,
      getLastFullCommitAt: () => lastCommitRef.full,
      // Anchor for the inc batch window: epoch-ms of the earliest pending
      // (post-cursor) event. Inc fires inc_interval_minutes after this, so
      // a burst of edits gets batched into one snapshot.
      getEarliestPendingObservedAt: () => {
        const pending = eventQueue.peekSince(eventQueue.committedThrough());
        if (pending.length === 0) return null;
        let earliestMs = Number.POSITIVE_INFINITY;
        for (const e of pending) {
          const ms = Date.parse(e.observed_at);
          if (Number.isFinite(ms) && ms < earliestMs) earliestMs = ms;
        }
        return earliestMs === Number.POSITIVE_INFINITY ? null : earliestMs;
      },
      preflightHost: noticeCenter,
      logger: this.logger,
      // Cast back to number for window.clearTimeout — the FSM works with an
      // opaque TimerHandle type so tests can stub it.
      setTimeoutFn: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeoutFn: (h) => window.clearTimeout(h as number),
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
          const result =
            pending.type === 'full'
              ? await backupService.runFull()
              : await backupService.runIncremental();

          const now = Date.now();
          if (pending.type === 'full') {
            lastCommitRef.full = now;
            lastCommitRef.inc = null;
          } else {
            lastCommitRef.inc = now;
          }

          manifestCache.invalidate();
          // Clear the chain-recovery banner if it was raised — recovery FULL
          // just succeeded. Idempotent when no banner exists.
          noticeCenter.clearPersistent('CHAIN_RECOVERY');
          // A successful backup recovers from any prior failure; drop the
          // generic backup-error banner and the lastError snapshot so the
          // status-bar click stops opening a stale ErrorDetailsModal.
          noticeCenter.clearPersistent('BACKUP_ERROR');
          lastErrorRef.current = null;
          noticeCenter.showSuccess(
            pending.type === 'full'
              ? { type: 'full' }
              : { type: 'inc', fileCount: result.filesWritten },
          );
          await maintenanceScheduler.scheduleRetentionIfDue();
          fsm.onBackupSuccess();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const stack = err instanceof Error ? (err.stack ?? null) : null;
          const isConflict = msg.includes('DEVICE_CONFLICT');
          const isQuota = msg.includes('QUOTA_EXCEEDED');
          const isAuthLost = msg.includes('TOKEN_REVOKED');
          // ConfigError is permanent — vault-id mismatch / corrupt remote
          // vault_meta / invalid local id. Retrying these on every tick
          // produces nothing but log noise and dedup-suppressed toasts.
          // The FSM has a separate BLOCKED state for exactly this class.
          const configBlockReason = err instanceof ConfigError
            ? configCodeToBlockReason(err.code)
            : null;

          if (configBlockReason !== null) {
            // Permanent error path — short-circuit ahead of the transient
            // banners so we don't double-handle.
            const errCode = (err as ConfigError).code;
            lastErrorRef.current = {
              code: errCode,
              message: msg,
              stack,
              at: Date.now(),
              kind: pending.type,
            };
            this.logger.error('backup_failed', {
              code: errCode,
              kind: pending.type,
              message: msg,
              stack,
              permanent: true,
            });
            // Try to populate the recovery record for the modal — best
            // effort. If the consistency probe is reachable here we'll
            // get full local + remote IDs; otherwise the modal falls
            // back to the rawError branch.
            void (async (): Promise<void> => {
              try {
                const probe = await vaultIdentity.checkConsistency();
                if (probe.kind === 'mismatch') {
                  mismatchRecordRef.current = {
                    kind: 'mismatch',
                    localVaultId: probe.localId,
                    remoteVaultId: probe.remote.vault_id,
                    remoteVaultName: probe.remote.vault_name,
                    rawError: null,
                  };
                } else if (probe.kind === 'remote-corrupt') {
                  mismatchRecordRef.current = {
                    kind: 'remote-corrupt',
                    localVaultId: probe.localId || null,
                    remoteVaultId: null,
                    remoteVaultName: null,
                    rawError: probe.rawError,
                  };
                }
              } catch {
                // Probe failed — leave whatever record we have.
              }
            })();
            noticeCenter.clearPersistent('CHAIN_RECOVERY');
            surfaceBlockingConfigError(configBlockReason, msg);
            fsm.onBackupBlocked(configBlockReason);
            return;
          }

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

          // Persist enough detail for the status-bar ErrorDetailsModal AND
          // emit a logger.error so the dev console shows the actual cause —
          // previously the catch only emitted an FSM transition (debug) and
          // a generic toast, leaving users staring at "Network error — will
          // retry automatically." with no way to find the real failure.
          lastErrorRef.current = {
            code,
            message: msg,
            stack,
            at: Date.now(),
            kind: pending.type,
          };
          this.logger.error('backup_failed', {
            code,
            kind: pending.type,
            message: msg,
            stack,
          });

          // Recovery FULL itself failed — clear the chain-recovery banner so
          // the user isn't left staring at "running fresh full backup" while
          // the actual error toast tells them otherwise.
          noticeCenter.clearPersistent('CHAIN_RECOVERY');
          // For NETWORK / unclassified failures none of the dedicated
          // banners (AUTH_LOST / DEVICE_CONFLICT / QUOTA_EXCEEDED) fire, so
          // the user is left with only a 5-min-deduped toast that doesn't
          // include the actual error text. Promote those to a persistent
          // BACKUP_ERROR banner that carries the real message — same
          // banner pipeline the settings tab and the status bar already
          // observe.
          if (!isAuthLost && !isConflict && !isQuota) {
            noticeCenter.showPersistent(
              'BACKUP_ERROR',
              S.BACKUP_ERROR_BANNER(pending.type, msg),
              {
                onDismiss: () => {
                  noticeCenter.clearPersistent('BACKUP_ERROR');
                  lastErrorRef.current = null;
                },
                dismissLabel: S.BACKUP_ERROR_DISMISS,
              },
            );
          }
          noticeCenter.showError(code, msg);
          fsm.onBackupFailure();
        }
      })();
    });

    // ---------------------------------------------------------------------------
    // Step 12: RibbonIcon
    // ---------------------------------------------------------------------------
    // Open-or-focus pattern. Earlier `getLeaf(false)` always created a new
    // leaf, so every ribbon click / command palette invocation stacked
    // another Backup Browser tab. Now: if a leaf already hosts our view
    // type, reveal it; only fall back to creating one when none exists.
    const openBrowser = (): void => {
      const workspace = this.app.workspace as unknown as {
        getLeavesOfType: (type: string) => Array<{
          setViewState?: (s: unknown) => Promise<void> | void;
        }>;
        revealLeaf: (leaf: unknown) => void;
        getLeaf: (newLeaf: boolean) => {
          setViewState: (s: unknown) => Promise<void> | void;
        } | null;
      };
      const existing = workspace.getLeavesOfType(BACKUP_BROWSER_VIEW_TYPE);
      if (existing.length > 0) {
        workspace.revealLeaf(existing[0]);
        return;
      }
      const leaf = workspace.getLeaf(false);
      if (leaf) {
        void leaf.setViewState({
          type: BACKUP_BROWSER_VIEW_TYPE,
          active: true,
        });
        workspace.revealLeaf(leaf);
      }
    };

    // Open or focus the per-file FileVersionsView, scoped to a vault path.
    // Right-click on a file in BackupBrowserView routes here. Always opens
    // a new tab — multiple files can be inspected side by side.
    const openFileVersions = (path: string): void => {
      const workspace = this.app.workspace as unknown as {
        getLeavesOfType: (type: string) => Array<{
          getViewState: () => { state?: { path?: string } };
          setViewState: (s: unknown) => Promise<void> | void;
        }>;
        revealLeaf: (leaf: unknown) => void;
        getLeaf: (newLeaf: boolean) => {
          setViewState: (s: unknown) => Promise<void> | void;
        } | null;
      };
      const existing = workspace.getLeavesOfType(FILE_VERSIONS_VIEW_TYPE);
      const sameLeaf = existing.find((l) => l.getViewState?.().state?.path === path);
      if (sameLeaf) {
        workspace.revealLeaf(sameLeaf);
        return;
      }
      const leaf = workspace.getLeaf(true);
      if (leaf) {
        void leaf.setViewState({
          type: FILE_VERSIONS_VIEW_TYPE,
          active: true,
          state: { path },
        });
        workspace.revealLeaf(leaf);
      }
    };

    const ribbonHost: RibbonHost = {
      create: ({ icon, title, onClick }) => {
        const el = this.addRibbonIcon(icon, title, onClick as (evt: MouseEvent) => unknown);
        // Track which archivist-* classes WE added so we can remove them on
        // state change without clobbering Obsidian's own classes
        // (`side-dock-ribbon-action`, etc.) that handle layout / centering.
        // The earlier `el.className = cls` overwrite was wiping those, which
        // visually displaced the icon inside its slot.
        let appliedArchivistClasses: string[] = [];
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
            const next = cls.split(/\s+/).filter((c) => c.length > 0);
            const elTyped = el as unknown as {
              addClass: (c: string) => void;
              removeClass: (c: string) => void;
            };
            // Remove only the archivist-* classes we added previously.
            for (const old of appliedArchivistClasses) elTyped.removeClass(old);
            for (const fresh of next) elTyped.addClass(fresh);
            appliedArchivistClasses = next;
          },
          destroy: () => {
            (el as unknown as { remove?: () => void }).remove?.();
          },
        };
        return handle;
      },
    };

    // Tooltip input supplier — read at the moment of every render so the
    // user sees the freshest countdown. Cheap (just a few getters); safe to
    // call from refresh-on-tick and refresh-on-vault-activity.
    const getTooltipInput = (): import('./ui/StatusTooltip').StatusTooltipInput => ({
      state: fsm.getState(),
      graceEndAt: fsm.getGraceEndAt(),
      quietWaitEndAt: fsm.getQuietWaitEndAt(),
      nextIncEligibleAt: fsm.getNextIncEligibleAt(),
      nextScheduledFullAt: fsm.getNextScheduledFullAt(),
      queueSize: eventQueue.peekSince(eventQueue.committedThrough()).length,
      now: Date.now(),
      progress: progressTracker.getSnapshot(),
    });

    this.ribbon = new RibbonIcon({
      host: ribbonHost,
      fsm,
      onRibbonClick: openBrowser,
      getTooltipInput,
    });
    this.ribbon.mount();

    // Status-bar mirror — same FSM signal in the bottom status bar so users
    // who collapse the ribbon column still see plugin state. Click opens
    // the same Backup Browser as the ribbon icon.
    const statusBarEl = this.addStatusBarItem();
    statusBarEl.addClass('mod-clickable');
    let statusIconEl: HTMLElement | null = null;
    let appliedStatusClasses: string[] = [];
    const statusBarHost: StatusBarHost = {
      create: ({ onClick }) => {
        statusBarEl.empty();
        statusIconEl = statusBarEl.createSpan({ cls: 'archivist-status-icon' });
        // Per user feedback: text label takes too much space in the status
        // bar. Keep the StatusBar.setLabel API for symmetry with the ribbon
        // tooltip, but route it into aria-label only — screen readers and
        // hover tooltips still get the state copy, the visual surface stays
        // icon-only.
        this.registerDomEvent(statusBarEl, 'click', onClick);
        const handle: StatusBarHandle = {
          setIcon: (name) => {
            if (statusIconEl) setIcon(statusIconEl, name);
          },
          setLabel: (text) => {
            statusBarEl.setAttribute('aria-label', text);
          },
          setAriaLabel: (label) => {
            statusBarEl.setAttribute('aria-label', label);
          },
          setCssClass: (cls) => {
            const next = cls.split(/\s+/).filter((c) => c.length > 0);
            for (const old of appliedStatusClasses) statusBarEl.removeClass(old);
            for (const fresh of next) statusBarEl.addClass(fresh);
            appliedStatusClasses = next;
          },
          destroy: () => {
            statusBarEl.remove();
          },
        };
        return handle;
      },
    };
    // Status-bar click is state-aware: in healthy states (READY / GRACE /
    // QUIET_WAIT / BACKUP_RUNNING / PASSIVE) it mirrors the ribbon and opens
    // the Backup Browser. In ERROR / AUTH_LOST it opens the ErrorDetailsModal
    // — the alert-triangle is the user's signal that something is wrong, so
    // a click should explain the problem, not navigate away from it.
    const openErrorDetails = (): void => {
      const app = this.app as unknown as {
        setting?: {
          open: () => void;
          openTabById: (id: string) => void;
        };
      };
      new ErrorDetailsModal(this.app, {
        lastError: lastErrorRef.current,
        onOpenSettings: () => {
          // app.setting is Obsidian's internal handle to the Settings dialog.
          // It's the same surface used by /open-settings command palettes
          // across community plugins; gracefully degrade if unavailable.
          if (app.setting) {
            app.setting.open();
            app.setting.openTabById(this.manifest.id);
          }
        },
        onCopy: async (report) => {
          await (navigator as unknown as {
            clipboard: { writeText: (t: string) => Promise<void> };
          }).clipboard.writeText(report);
          new Notice(`${NOTICE_PREFIX}${S.ERROR_DETAILS_COPIED}`, 3_000);
        },
      }).open();
    };
    const openMismatchRecovery = (): void => {
      const record = mismatchRecordRef.current;
      if (!record) {
        // Defensive — BLOCKED without a record means the consistency
        // probe failed to populate (transient Dropbox error). Fall
        // back to the generic ErrorDetailsModal so the user still
        // sees something actionable.
        openErrorDetails();
        return;
      }
      new MismatchRecoveryModal(this.app, {
        record,
        onAdoptRemote: async () => {
          if (!record.remoteVaultId) {
            // remote-corrupt path: shouldn't be reachable (no Adopt
            // button rendered), but guard anyway.
            return;
          }
          try {
            await vaultIdentity.adoptVaultId(record.remoteVaultId);
            this.logger.info('vault_id_adopted_via_recovery', {
              remote_id: record.remoteVaultId,
              remote_name: record.remoteVaultName,
            });
            new Notice(
              `${NOTICE_PREFIX}${S.MISMATCH_RECOVERY_OK(record.remoteVaultName ?? 'remote')}`,
              4_000,
            );
            mismatchRecordRef.current = null;
            lastErrorRef.current = null;
            clearBlockingNotice();
            noticeCenter.clearPersistent('VAULT_ID_MISMATCH');
            noticeCenter.clearPersistent('VAULT_META_CORRUPT');
            // Release the FSM so the next tick (or the user's next
            // manual trigger) can run a real backup.
            fsm.clearBlock();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.error('vault_id_adoption_failed', { error: msg });
            new Notice(`${NOTICE_PREFIX}${S.MISMATCH_RECOVERY_FAILED(msg)}`, 0);
          }
        },
        onChangePrefix: () => {
          const app = this.app as unknown as {
            setting?: { open: () => void; openTabById: (id: string) => void };
          };
          if (app.setting) {
            app.setting.open();
            app.setting.openTabById(this.manifest.id);
          }
        },
        onCancel: () => {},
      }).open();
    };
    // Wire the forward reference used by surfaceBlockingConfigError (banner
    // Resolve action + sticky-notice click) now that the modal opener exists.
    openRecovery = openMismatchRecovery;

    const statusBarOnClick = (): void => {
      const state = fsm.getState();
      if (state === 'BLOCKED') {
        openMismatchRecovery();
        return;
      }
      if (state === 'ERROR' || state === 'AUTH_LOST') {
        openErrorDetails();
        return;
      }
      openBrowser();
    };
    const statusBar = new StatusBar({
      host: statusBarHost,
      fsm,
      onClick: statusBarOnClick,
      getTooltipInput,
    });
    statusBar.mount();

    // Drive the live countdown: refresh tooltips on every tick (minute
    // resolution is enough for "in N min" copy) and immediately on vault
    // activity (instant proof that the edit was detected — quiet-timer
    // reset shows up in the countdown).
    const refreshTooltips = (): void => {
      this.ribbon?.refresh();
      statusBar.refresh();
    };

    // Backup progress drives the same refresh path: each (throttled)
    // setPhase / advance / end firing repaints both the status-bar and
    // ribbon tooltips so the user sees live "uploading 432/5988" counts.
    // Tracker throttles to ~4 updates/sec so the upload phase doesn't burn
    // CPU on tooltip repaints.
    this.register(progressTracker.subscribe(refreshTooltips));

    // ---------------------------------------------------------------------------
    // Step 13: ChangeDetector — register live vault-event handlers
    // ---------------------------------------------------------------------------
    // The detector itself was constructed earlier (Step 7) so BackupService
    // can use it for the startup reconcile pass. Here we wire it to the live
    // vault events (modify / create / delete / rename) so the queue stays
    // current while Obsidian runs.
    changeDetector.setOnVaultActivity(() => {
      fsm.onVaultEvent();
      // Instant tooltip refresh so the user sees the QUIET_WAIT countdown
      // restart from the full quiet_after_event_minutes. This is the live
      // diagnostic proof that the change was detected.
      refreshTooltips();
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
        // Async fetch of the snapshot chain + per-path version list, then
        // open the modal. Errors fall back to a toast — the modal itself
        // doesn't have a "loading failed" state and we'd rather not show an
        // empty modal on a broken cache.
        void (async (): Promise<void> => {
          try {
            const snapshots = await manifestCache.listSnapshotsNewestFirst();
            const manifests = await Promise.all(
              snapshots.map((s) => manifestCache.loadManifest(s.id)),
            );
            const entries = restoreService.listVersionsForPath(path, manifests);
            const stat = await vaultAdapter.stat(path).catch(() => null);
            new FileHistoryModal(this.app, {
              currentPath: path,
              entries,
              restoreService,
              restoreOperations,
              vaultInfo: {
                exists: stat !== null,
                size: stat?.size ?? 0,
                mtime: stat?.mtime ?? 0,
              },
              vaultHasPath,
            }).open();
          } catch (err) {
            this.logger.warn('show_history_command_failed', {
              error: err instanceof Error ? err.message : String(err),
            });
            notify(S.TOAST_ERROR_GENERIC);
          }
        })();
      },
    });
    registerRepairCommands({
      plugin: this,
      repair: repairService,
      notify,
      logger: this.logger,
    });
    registerRetentionCommands({
      plugin: this,
      retention: retentionService,
      notify,
      logger: this.logger,
    });
    registerVerifyVaultOwnershipCommand({
      plugin: this,
      vaultIdentity,
      notify,
      logger: this.logger,
    });

    // ---------------------------------------------------------------------------
    // Step 15: Settings tab
    // ---------------------------------------------------------------------------
    const settingsContext: SettingsContext = {
      getSettings: () => cachedRef.settings,
      updateSettings: async (patch) => {
        const merged = { ...cachedRef.settings, ...patch };
        cachedRef.settings = merged;
        await pluginStore.saveSettings(merged);
      },
      deviceId: '',
      deviceDesignated: true,
      dropboxAccountEmail: null,
      dropboxUsedBytes: 0,
      device: {
        getDeviceId: () => deviceCoordinator.getOrCreateDeviceId(),
        isDesignated: () => Promise.resolve(true),
        takeOwnership: (_label?: string) => Promise.resolve(),
        releaseOwnership: () => Promise.resolve(),
      },
      dropbox: {
        // Source of truth for the connected account is the secret store
        // (ADR-21) — survives plugin reload because it's persisted by
        // OAuthConnectFlow + the post-callback re-save in the protocol
        // handler above.
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
        getUsedBytes: () => Promise.resolve(0),
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
      confirm: () => Promise.resolve(true),
    };

    // Pre-populate every async-sourced settingsContext field so the FIRST
    // refreshAsyncFields tick after the tab opens sees no diff and doesn't
    // rebuild the DOM. Skipping this caused a real-world bug: while the user
    // typed into the Vault-prefix textbox, the async deviceId fetch resolved
    // a few hundred ms later, refreshAsyncFields detected ctx.deviceId went
    // from '' to a real UUID, called display(), and wiped the in-progress
    // input — leaving data.json with vault_prefix: '' even after the user
    // saved twice in a row.
    settingsContext.deviceId = await deviceCoordinator
      .getOrCreateDeviceId()
      .catch(() => settingsContext.deviceId);

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

    // Backfill: if tokens exist but the email field is empty (either from a
    // pre-fix install, or because fetchAccountEmail had a network blip during
    // the original OAuth callback), fetch + persist it now. Fire-and-forget so
    // onload doesn't block on the network call. The settings tab redraws via
    // refresh() once the email lands.
    if (existingTokens && !existingTokens.dropbox_account_email) {
      void (async (): Promise<void> => {
        const email = await this.oauthFlow!.fetchAccountEmail(existingTokens.access_token);
        if (!email) return;
        await tokenStore.save({ ...existingTokens, dropbox_account_email: email });
        settingsContext.dropboxAccountEmail = email;
        this.logger.info('account_email_backfilled');
        await this.settingsTab?.refresh();
      })();
    }

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
        vaultHasPath,
        notify,
        app: this.app,
      });
    });

    this.registerView(FILE_VERSIONS_VIEW_TYPE, (leaf) => {
      return new FileVersionsView(leaf, {
        restoreService,
        manifestCache,
        restoreOperations,
        noticeCenter: {
          showPersistent: (code, message, opts) =>
            noticeCenter.showPersistent(code, message, opts),
        },
        vaultHasPath,
        notify,
        app: this.app,
      });
    });

    // ---------------------------------------------------------------------------
    // Step 16b: FileVersionsView entry points — Obsidian file-menu
    // ---------------------------------------------------------------------------
    // Single `file-menu` event covers the file explorer's right-click context
    // menu AND the markdown view's three-dots more-options menu (Obsidian
    // dispatches both through the same hook with different `source` strings).
    // Folders dispatch the same event but we only show the entry for files —
    // directory restore lives in BackupBrowserView. registerEvent ensures the
    // listener is detached on plugin unload.
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        // TFolder has no `extension`; using the duck-typed `extension` check
        // sidesteps importing TFile/TFolder just for an instanceof guard.
        if (!('extension' in file)) return;
        menu.addItem((item) =>
          item
            .setTitle(S.BROWSER_CONTEXT_RESTORE_DOTS)
            .setIcon('archive-restore')
            .onClick(() => openFileVersions(file.path)),
        );
      }),
    );

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
    // CRITICAL: use `workspace.onLayoutReady(cb)` (the helper), NOT
    // `workspace.on('layout-ready', cb)`. When the user enables the plugin
    // AFTER Obsidian has already loaded the workspace, the `layout-ready`
    // event has already fired — registering a listener for it via `on(...)`
    // attaches a callback that never runs, so `fsm.onLayoutReady()` is never
    // called and the FSM stays in LOADING forever (no GRACE → QUIET_WAIT →
    // READY chain, no auto-inc, only manual `triggerBackupNow` works). The
    // helper variant fires the callback immediately when layout is already
    // ready, otherwise registers a one-shot listener.
    this.app.workspace.onLayoutReady(() => {
      fsm.onLayoutReady();
      fsm.recoverOnStartup();
      predecessorDetector.check();
      // Vault-id consistency probe: surfaces the Adopt modal on first
      // launch when this vault has no local id but the configured
      // Dropbox folder already has a vault_meta. We run this AFTER
      // layout-ready so the modal lands in a workspace the user can
      // see (running it during onload would race with Obsidian's own
      // startup-modal queue). Errors from the probe (Dropbox not
      // connected yet, transient network) are non-fatal — the same
      // probe re-runs on every layout-ready of every plugin reload,
      // and BackupService blocks writes until the IDs agree.
      void (async (): Promise<void> => {
        try {
          const result = await vaultIdentity.checkConsistency();
          if (result.kind === 'adopt-remote') {
            new AdoptVaultModal(this.app, {
              remoteVaultName: result.remote.vault_name,
              remoteVaultId: result.remote.vault_id,
              // M5: await the adoption write and surface failures via
              // toast — the previous fire-and-forget swallowed
              // saveVaultId errors silently, leaving the user clicking
              // away on a modal that pretended to succeed while the
              // local id never persisted.
              onAdopt: () => {
                void (async (): Promise<void> => {
                  try {
                    await vaultIdentity.adoptVaultId(result.remote.vault_id);
                    new Notice(`${NOTICE_PREFIX}${S.ADOPT_VAULT_OK(result.remote.vault_name)}`);
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    new Notice(`${NOTICE_PREFIX}${S.ADOPT_VAULT_FAILED(msg)}`, 0);
                    this.logger.error('vault_id_adoption_failed', { error: msg });
                  }
                })();
              },
              onCancel: () => {},
            }).open();
          } else if (result.kind === 'remote-corrupt') {
            // Proactive lock — same surface path as a mid-backup
            // ConfigError: setBlocked + persistent banner + recovery
            // record, except we hit this BEFORE the first backup
            // attempt so the FSM is shielded from the retry loop from
            // tick 1.
            this.logger.warn('vault_meta_corrupt_surfaced', { error: result.rawError });
            mismatchRecordRef.current = {
              kind: 'remote-corrupt',
              localVaultId: result.localId || null,
              remoteVaultId: null,
              remoteVaultName: null,
              rawError: result.rawError,
            };
            surfaceBlockingConfigError('VAULT_META_CORRUPT', result.rawError);
            fsm.setBlocked('VAULT_META_CORRUPT');
          } else if (result.kind === 'mismatch') {
            // The case that motivated this whole flow: local got an
            // auto-generated vault_id at onload, remote already has a
            // different one. Surface immediately so the user can recover
            // before the first backup tick.
            this.logger.warn('vault_id_mismatch_surfaced', {
              local: result.localId,
              remote: result.remote.vault_id,
              remote_name: result.remote.vault_name,
            });
            mismatchRecordRef.current = {
              kind: 'mismatch',
              localVaultId: result.localId,
              remoteVaultId: result.remote.vault_id,
              remoteVaultName: result.remote.vault_name,
              rawError: null,
            };
            surfaceBlockingConfigError(
              'VAULT_ID_MISMATCH',
              `local ${result.localId} ≠ remote ${result.remote.vault_id}`,
            );
            fsm.setBlocked('VAULT_ID_MISMATCH');
          }
        } catch (err) {
          this.logger.debug('vault_identity_probe_skipped', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    });

    // ---------------------------------------------------------------------------
    // Step 19: Tick interval
    // ---------------------------------------------------------------------------
    this.registerInterval(
      window.setInterval(() => {
        fsm.tick();
        refreshTooltips();
      }, 60_000),
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
