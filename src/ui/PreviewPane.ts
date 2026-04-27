// PreviewPane — safe content rendering for Backup Browser and File History Modal.
//
// Security contract (ADR-13):
//   - ALL text rendering goes through MarkdownRenderer.render — never innerHTML.
//   - Binary files (by extension) show a placeholder; they never reach
//     MarkdownRenderer.
//   - Path text is inserted via createEl text nodes — never raw HTML.
//   - detectCodeEvalPlugins + maybeShowPreviewAdvisory implement the SEC-H3
//     threat-model boundary advisory for co-installed code-evaluating plugins.
//
// Separation of concerns:
//   - renderPreview: pure rendering (no NoticeCenter dependency).
//   - renderPathSpan: single-responsibility path text insertion.
//   - detectCodeEvalPlugins: pure query, no side effects.
//   - maybeShowPreviewAdvisory: advisory wiring; BackupBrowserView calls this
//     on first open, not renderPreview, so PreviewPane stays side-effect-free.

import { MarkdownRenderer, type App, type Component } from 'obsidian';
import { S } from './strings';
import type { AppWithPluginRegistry } from '../services/PredecessorDetector';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal container interface for preview rendering.
 * Obsidian augments HTMLElement with createEl at runtime; this interface
 * captures that contract without relying on DOM lib globals that TypeScript
 * can't verify in the ESLint pass.
 */
export interface PreviewContainerEl {
  createEl<K extends string>(
    tag: K,
    opts?: { text?: string; cls?: string; attr?: Record<string, string> },
  ): PreviewContainerEl;
  createSpan(
    opts?: { text?: string; cls?: string; attr?: Record<string, string> },
  ): PreviewContainerEl;
}

// AppWithPluginRegistry is re-exported from PredecessorDetector — one definition.
export type { AppWithPluginRegistry } from '../services/PredecessorDetector';

export interface PreviewAdvisoryNoticeCenter {
  showPersistent(
    code: string,
    message: string,
    opts?: {
      onDismiss?: () => void | Promise<void>;
      dismissLabel?: string;
    },
  ): void;
}

// ---------------------------------------------------------------------------
// Binary detection
// ---------------------------------------------------------------------------

// Extensions that are always treated as binary — never fed to MarkdownRenderer.
// Unknown extensions fall through to TextDecoder (replacement chars for bad bytes).
const BINARY_EXTENSIONS = new Set([
  // Images
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico',
  // Documents
  '.pdf',
  // Audio / Video
  '.mp3', '.mp4', '.mov', '.wav',
  // Archives
  '.zip', '.tar', '.gz',
]);

function isBinary(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return false;
  return BINARY_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

// ---------------------------------------------------------------------------
// renderPreview
// ---------------------------------------------------------------------------

/**
 * Render backup content into containerEl.
 *   - Binary paths/content → show FILE_HISTORY_BINARY_PLACEHOLDER.
 *   - Text paths/content   → decode UTF-8 and call MarkdownRenderer.render.
 *
 * @param app         - Obsidian App instance (required by MarkdownRenderer.render).
 * @param containerEl - host element; must support createEl (Obsidian HTMLElement / MockEl).
 * @param content     - raw file bytes from the backup store.
 * @param path        - vault-relative file path (used for extension detection + source path).
 * @param component   - Obsidian Component for child-component lifecycle tracking.
 */
export async function renderPreview(
  app: App,
  containerEl: PreviewContainerEl,
  content: Uint8Array,
  path: string,
  component: Component,
): Promise<void> {
  if (isBinary(path)) {
    containerEl.createEl('p', { text: S.FILE_HISTORY_BINARY_PLACEHOLDER });
    return;
  }

  const text = new TextDecoder('utf-8', { fatal: false }).decode(content);
  // Cast is safe: production callers pass an Obsidian HTMLElement which Obsidian
  // augments with createEl; the PreviewContainerEl interface verifies createEl
  // is available at the type-check level.
  await MarkdownRenderer.render(app, text, containerEl as HTMLElement, path, component);
}

// ---------------------------------------------------------------------------
// renderPathSpan (SEC-L2)
// ---------------------------------------------------------------------------

/**
 * Insert a file-tree path as a text-safe span element.
 * Uses createEl so the text goes through Obsidian's DOM API, never innerHTML.
 * Safe for paths containing <, >, ", & characters.
 */
export function renderPathSpan(
  containerEl: PreviewContainerEl,
  path: string,
): void {
  containerEl.createSpan({ text: path });
}

// ---------------------------------------------------------------------------
// detectCodeEvalPlugins
// ---------------------------------------------------------------------------

const RISKY_PLUGIN_IDS = [
  'dataview',
  'templater-obsidian',
  'obsidian-tasks-plugin',
] as const;

/**
 * Returns the IDs of currently-enabled plugins that are known to execute
 * code during MarkdownRenderer.render (via registered post-processors).
 * Empty array means no code-evaluating plugins are active.
 */
export function detectCodeEvalPlugins(app: AppWithPluginRegistry): string[] {
  return RISKY_PLUGIN_IDS.filter((id) => app.plugins.enabledPlugins.has(id));
}

// ---------------------------------------------------------------------------
// maybeShowPreviewAdvisory (SEC-H3)
// ---------------------------------------------------------------------------

const ADVISORY_BANNER_CODE = 'PREVIEW_ADVISORY';

/**
 * Show a one-time advisory notice when code-evaluating plugins are installed.
 * Must be called by BackupBrowserView on first open per session.
 *
 * The advisory is NOT shown again once the user dismisses it — dismissal is
 * persisted via saveSettings (caller reads/writes data.json.ui.preview_plugin_advisory_dismissed).
 *
 * @param app          - Obsidian App (or test stub) for plugin registry access.
 * @param noticeCenter - NoticeCenter (subset) for persistent banner display.
 * @param isDismissed  - returns true when the user has already dismissed the advisory.
 * @param saveSettings - called when the user clicks Dismiss; caller persists the flag.
 */
export function maybeShowPreviewAdvisory(
  app: AppWithPluginRegistry,
  noticeCenter: PreviewAdvisoryNoticeCenter,
  isDismissed: () => boolean,
  saveSettings: () => Promise<void>,
): void {
  if (isDismissed()) return;

  const riskyPlugins = detectCodeEvalPlugins(app);
  if (riskyPlugins.length === 0) return;

  noticeCenter.showPersistent(ADVISORY_BANNER_CODE, S.PREVIEW_PLUGIN_ADVISORY, {
    dismissLabel: S.PREVIEW_PLUGIN_ADVISORY_DISMISS,
    onDismiss: () => saveSettings(),
  });
}
