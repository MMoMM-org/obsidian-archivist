// SettingsContext — snapshot of dependencies each section renderer needs.
//
// Kept deliberately thin: only the behavioural surfaces a section touches
// (read settings, persist changes, call through to OAuth / device /
// storage-probe services). Tests assemble a minimal context with fakes.

import type { PluginSettings } from '../../model/Settings';

export interface DeviceSurface {
  getDeviceId(): Promise<string>;
  isDesignated(): Promise<boolean>;
  takeOwnership(label?: string): Promise<void>;
  releaseOwnership(): Promise<void>;
}

export interface DropboxSurface {
  /** Null when disconnected. */
  getAccountEmail(): Promise<string | null>;
  disconnect(): Promise<void>;
  /** Current bytes used under the plugin's app-scoped Dropbox folder. */
  getUsedBytes(): Promise<number>;
}

export interface OAuthSurface {
  isConnected(): Promise<boolean>;
  beginAuth(): Promise<void>;
}

export interface RetentionProfile {
  /** Approximate vault size in bytes (from index statistics). */
  vault_bytes: number;
  /** Average edits per day over the last 7 days (for snapshot-count projection). */
  avg_edits_per_day: number;
}

export interface RetentionEstimate {
  snapshots: number;
  gb: number;
}

export interface SettingsContext {
  getSettings: () => PluginSettings;
  updateSettings: (patch: Partial<PluginSettings>) => Promise<void>;
  device: DeviceSurface;
  dropbox: DropboxSurface;
  oauth: OAuthSurface;
  getRetentionProfile: () => RetentionProfile;
  estimateRetention: (profile: RetentionProfile, settings: PluginSettings) => RetentionEstimate;
  copyToClipboard: (text: string) => Promise<void>;
  /** Opens a confirmation dialog; resolves with the user's choice. */
  confirm: (opts: { title: string; body: string; okLabel: string; cancelLabel: string }) => Promise<boolean>;
}
