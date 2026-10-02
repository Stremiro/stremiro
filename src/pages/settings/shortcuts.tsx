import { ShortcutTable } from '@/components/shortcut-table';
import { BROWSE_SHORTCUTS, CALENDAR_SHORTCUTS, PLAYER_SHORTCUTS } from '@/lib/shortcuts';
import { SettingsGroup, SettingsGroupHeader } from './chrome';

export function ShortcutsSection() {
  return (
    <div className='flex flex-col gap-6'>
      <SettingsGroup>
        <SettingsGroupHeader title='Player shortcuts' description='Active during playback.' />
        <ShortcutTable shortcuts={PLAYER_SHORTCUTS} className='p-4' />
      </SettingsGroup>
      <SettingsGroup>
        <SettingsGroupHeader
          title='Browse shortcuts'
          description='Active on every page outside the player.'
        />
        <ShortcutTable shortcuts={BROWSE_SHORTCUTS} className='p-4' />
      </SettingsGroup>
      <SettingsGroup>
        <SettingsGroupHeader
          title='Calendar shortcuts'
          description='Active on the Calendar page.'
        />
        <ShortcutTable shortcuts={CALENDAR_SHORTCUTS} className='p-4' />
      </SettingsGroup>
    </div>
  );
}
