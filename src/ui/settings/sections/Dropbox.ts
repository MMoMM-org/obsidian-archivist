// Dropbox section — populated in T7.10.

import type { SectionHost } from '../SectionHost';
import type { SettingsContext } from '../context';
import { S } from '../../strings';

export function renderDropbox(host: SectionHost, _ctx: SettingsContext): void {
  host.heading(S.SETTINGS_SECTION_DROPBOX);
}
