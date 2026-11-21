// Notifications section (T7.9 — PRD Notifications defaults).
//
// Four toggles with the PRD-mandated defaults: pre-flight=ON,
// toast_after_inc=OFF, toast_after_full=ON, toast_on_error=ON.

import type { SectionHost } from '../SectionHost';
import type { SettingsContext } from '../context';
import { S } from '../../strings';

export function renderNotifications(host: SectionHost, ctx: SettingsContext): void {
  host.heading(S.SETTINGS_SECTION_NOTIFICATIONS);

  const settings = ctx.getSettings();
  const n = settings.notifications;

  host.field({
    kind: 'toggle',
    key: 'notifications.preflight_notice_enabled',
    label: S.SETTINGS_PREFLIGHT_NOTICE,
    value: n.preflight_notice_enabled,
    onChange: (v) => {
      return ctx.updateSettings({
        notifications: { ...n, preflight_notice_enabled: v },
      });
    },
  });

  host.field({
    kind: 'toggle',
    key: 'notifications.toast_after_inc',
    label: S.SETTINGS_TOAST_AFTER_INC,
    value: n.toast_after_inc,
    onChange: (v) => {
      return ctx.updateSettings({
        notifications: { ...n, toast_after_inc: v },
      });
    },
  });

  host.field({
    kind: 'toggle',
    key: 'notifications.toast_after_full',
    label: S.SETTINGS_TOAST_AFTER_FULL,
    value: n.toast_after_full,
    onChange: (v) => {
      return ctx.updateSettings({
        notifications: { ...n, toast_after_full: v },
      });
    },
  });

  host.field({
    kind: 'toggle',
    key: 'notifications.toast_on_error',
    label: S.SETTINGS_TOAST_ON_ERROR,
    value: n.toast_on_error,
    onChange: (v) => {
      return ctx.updateSettings({
        notifications: { ...n, toast_on_error: v },
      });
    },
  });
}
