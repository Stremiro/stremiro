import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAppUiPreferences } from '@/hooks/use-app-ui-preferences';
import { api, getErrorMessage, type StartupPage } from '@/lib/api';
import { notifyAction } from '@/lib/notify';
import { flushPendingAppWrites } from '@/lib/pending-app-writes';
import { APP_UI_PREFERENCES_QUERY_KEY } from '@/lib/query-invalidation';
import { cn } from '@/lib/utils';
import {
  SETTINGS_OUTLINE_BUTTON_CLASS,
  SettingsBody,
  SettingsGroup,
  SettingsGroupHeader,
  SettingsQueryError,
  SettingsRow,
  SettingsSwitch,
} from './chrome';

const LAUNCH_AT_LOGIN_QUERY_KEY = ['launch-at-login'] as const;
export const START_PAGES = [
  { value: 'home', label: 'Home' },
  { value: 'library', label: 'Library' },
  { value: 'calendar', label: 'Calendar' },
  { value: 'lastVisited', label: 'Last visited' },
] as const satisfies readonly { value: StartupPage; label: string }[];

export function GeneralSettings() {
  const queryClient = useQueryClient();
  const { preferences, isHydrating, preferencesQuery, updatePreferences } = useAppUiPreferences(
    ({ closeToTray, minimizeToTray, startMinimized, startupPage }) => ({
      closeToTray,
      minimizeToTray,
      startMinimized,
      startupPage,
    }),
  );
  const launchQuery = useQuery({
    queryKey: LAUNCH_AT_LOGIN_QUERY_KEY,
    queryFn: api.getLaunchAtLogin,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const launchMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      await flushPendingAppWrites();
      return api.setLaunchAtLogin(enabled);
    },
    onSuccess: (enabled) => {
      queryClient.setQueryData(LAUNCH_AT_LOGIN_QUERY_KEY, enabled);
    },
    onError: (error) =>
      toast.error('Could not change launch at login.', { description: getErrorMessage(error) }),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: LAUNCH_AT_LOGIN_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: APP_UI_PREFERENCES_QUERY_KEY }),
      ]),
  });

  const launchPending = launchQuery.isFetching || launchMutation.isPending;
  const launchEnabled = launchQuery.data === true;
  const canStartMinimized = launchEnabled || preferences.closeToTray || preferences.minimizeToTray;
  const startPageLabel =
    START_PAGES.find((option) => option.value === preferences.startupPage)?.label ?? 'Home';

  return (
    <div className='space-y-5'>
      <SettingsQueryError query={preferencesQuery} message="Couldn't load your preferences." />
      <SettingsGroup>
        <SettingsGroupHeader
          title='Startup'
          description='Choose where Stremiro opens and how it starts with your device.'
        />
        <SettingsBody rows>
          <SettingsQueryError
            query={launchQuery}
            message='Could not read your login item setting.'
          />
          <SettingsRow label='Start page' description='The page shown when Stremiro opens.'>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant='outline'
                  aria-label={`Start page: ${startPageLabel}`}
                  disabled={isHydrating}
                  className={cn(
                    'h-9 min-w-36 justify-between px-3 text-[13px] shadow-none',
                    SETTINGS_OUTLINE_BUTTON_CLASS,
                  )}
                >
                  {startPageLabel}
                  <ChevronDown className='ml-3 h-4 w-4 text-zinc-500 opacity-70' />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align='end'
                className='min-w-40 border-white/10 bg-zinc-950 backdrop-blur-none'
              >
                {START_PAGES.map((option) => (
                  <DropdownMenuItem
                    key={option.value}
                    role='menuitemradio'
                    aria-checked={preferences.startupPage === option.value}
                    disabled={isHydrating}
                    onClick={() => updatePreferences({ startupPage: option.value })}
                    className='gap-2.5 rounded-lg px-3 py-2 text-sm text-zinc-200 cursor-pointer transition-colors hover:bg-white/10 hover:text-white'
                  >
                    {preferences.startupPage === option.value ? (
                      <Check className='h-4 w-4 text-white' />
                    ) : (
                      <span className='w-4' />
                    )}
                    {option.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </SettingsRow>
          <SettingsRow label='Launch at login' description='Open Stremiro when you sign in.'>
            <SettingsSwitch
              ariaLabel='Launch at login'
              checked={launchEnabled}
              disabled={launchPending || launchQuery.data === undefined}
              onChange={() => launchMutation.mutate(!launchEnabled)}
            />
          </SettingsRow>
          <SettingsRow
            label='Start minimized'
            description={
              canStartMinimized
                ? 'When launched at login, start in the system tray.'
                : 'Turn on Launch at login, Close to tray, or Minimize to tray to use this.'
            }
          >
            <SettingsSwitch
              ariaLabel='Start minimized'
              checked={preferences.startMinimized}
              disabled={isHydrating || !canStartMinimized || launchPending}
              onChange={() => updatePreferences({ startMinimized: !preferences.startMinimized })}
            />
          </SettingsRow>
        </SettingsBody>
      </SettingsGroup>
      <SettingsGroup>
        <SettingsGroupHeader title='Window' />
        <SettingsBody rows>
          <SettingsRow
            label='Close to tray'
            description='Closing the window keeps Stremiro running in the system tray.'
          >
            <SettingsSwitch
              ariaLabel='Close to tray'
              checked={preferences.closeToTray}
              disabled={isHydrating}
              onChange={() => updatePreferences({ closeToTray: !preferences.closeToTray })}
            />
          </SettingsRow>
          <SettingsRow
            label='Minimize to tray'
            description='Hide to the system tray instead of the taskbar when minimized.'
          >
            <SettingsSwitch
              ariaLabel='Minimize to tray'
              checked={preferences.minimizeToTray}
              disabled={isHydrating}
              onChange={() => updatePreferences({ minimizeToTray: !preferences.minimizeToTray })}
            />
          </SettingsRow>
          {(preferences.closeToTray || preferences.minimizeToTray) && (
            <div className='mt-3 flex justify-end'>
              <Button
                variant='ghost'
                size='sm'
                disabled={isHydrating}
                className='h-8 px-2.5 text-xs text-zinc-400 hover:bg-white/[0.04] hover:text-white'
                onClick={() =>
                  void api.hideMainWindowToTray().catch((error) =>
                    notifyAction('Could not hide window to tray', {
                      detail: getErrorMessage(error),
                      tone: 'error',
                    }),
                  )
                }
              >
                Hide to tray now
              </Button>
            </div>
          )}
        </SettingsBody>
      </SettingsGroup>
    </div>
  );
}
