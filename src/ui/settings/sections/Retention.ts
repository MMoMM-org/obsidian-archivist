// Retention section — populated in T7.8.

import type { SectionHost } from '../SectionHost';
import type { SettingsContext } from '../context';
import { S } from '../../strings';

export function renderRetention(host: SectionHost, _ctx: SettingsContext): void {
  host.heading(S.SETTINGS_SECTION_RETENTION);
}
