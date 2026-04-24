// Backup Schedule section — populated in T7.7.

import type { SectionHost } from '../SectionHost';
import type { SettingsContext } from '../context';
import { S } from '../../strings';

export function renderBackupSchedule(host: SectionHost, _ctx: SettingsContext): void {
  host.heading(S.SETTINGS_SECTION_SCHEDULE);
}
