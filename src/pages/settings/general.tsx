import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useAppUiPreferences } from '@/hooks/use-app-ui-preferences';
import { api, getErrorMessage, type StartupPage } from '@/lib/api';
import { notifyAction } from '@/lib/notify';
import { flushPendingAppWrites } from '@/lib/pending-app-writes';
import { APP_UI_PREFERENCES_QUERY_KEY } from '@/lib/query-invalidation';
import {
  SettingsBody,
  SettingsGroup,
  SettingsGroupHeader,
  SettingsQueryError,
  SettingsRow,
  SettingsSelect,
  SettingsSwitch,
} from './chrome';

const launchAtLoginQueryOptions = api.launchAtLoginQueryOptions();
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
  const launchQuery = useQuery(launchAtLoginQueryOptions);
  const launchMutation = useMutation({
    onMutate: async (enabled: boolean) => {
      await queryClient.cancelQueries({
        queryKey: launchAtLoginQueryOptions.queryKey,
        exact: true,
      });
      const previous = queryClient.getQueryData<boolean>(launchAtLoginQueryOptions.queryKey);
      queryClient.setQueryData(launchAtLoginQueryOptions.queryKey, enabled);
      return previous;
    },
    mutationFn: async (enabled: boolean) => {
      await flushPendingAppWrites();
      return api.setLaunchAtLogin(enabled);
    },
    onSuccess: async (enabled) => {
      await queryClient.cancelQueries({
        queryKey: launchAtLoginQueryOptions.queryKey,
        exact: true,
      });
      queryClient.setQueryData(launchAtLoginQueryOptions.queryKey, enabled);
    },
    onError: (error, _enabled, previous) => {
      if (previous !== undefined) {
        queryClient.setQueryData(launchAtLoginQueryOptions.queryKey, previous);
      }
      toast.error('Could not change launch at login.', { description: getErrorMessage(error) });
    },
    onSettled: async (_enabled, error) => {
      await flushPendingAppWrites().catch(() => undefined);
      await Promise.all([
        error != null &&
          queryClient.invalidateQueries({ queryKey: launchAtLoginQueryOptions.queryKey }),
        queryClient.invalidateQueries({ queryKey: APP_UI_PREFERENCES_QUERY_KEY }),
      ]);
    },
  });

  const launchPending = launchQuery.isLoading || launchMutation.isPending;
  const launchEnabled = launchQuery.data === true;
  const canStartMinimized = launchEnabled || preferences.closeToTray || preferences.minimizeToTray;
  const startPageLabel =
    START_PAGES.find((option) => option.value === preferences.startupPage)?.label ?? 'Home';

  return (
    <div className='space-y-5'>
      <SettingsQueryError query={preferencesQuery} message="Couldn't load your preferences." />
      <SettingsGroup>
        <SettingsGroupHeader title='Startup' />
        <SettingsBody rows>
          <SettingsQueryError
            query={launchQuery}
            message='Could not read your login item setting.'
          />
          <SettingsRow label='Start page' description='Where Stremiro opens.'>
            <SettingsSelect
              ariaLabel='Start page'
              valueLabel={startPageLabel}
              value={preferences.startupPage}
              options={START_PAGES}
              disabled={isHydrating}
              onChange={(startupPage) => updatePreferences({ startupPage })}
            />
          </SettingsRow>
          <SettingsRow label='Launch at login' description='Open Stremiro when you sign in.'>
            <SettingsSwitch
              ariaLabel='Launch at login'
              checked={launchEnabled}
              disabled={launchQuery.data === undefined}
              pending={launchPending}
              onChange={() => launchMutation.mutate(!launchEnabled)}
            />
          </SettingsRow>
          <SettingsRow
            label='Start minimized'
            description={
              canStartMinimized
                ? 'Start in the system tray.'
                : 'Needs Launch at login or a tray option.'
            }
          >
            <SettingsSwitch
              ariaLabel='Start minimized'
              checked={preferences.startMinimized}
              disabled={isHydrating || !canStartMinimized}
              pending={launchMutation.isPending}
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
            description='Keep running in the tray when the window closes.'
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
            description='Hide to the tray instead of the taskbar.'
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
