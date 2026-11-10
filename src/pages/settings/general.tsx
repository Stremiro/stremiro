import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AppWindow,
  House,
  Minimize2,
  PanelBottom,
  PanelBottomClose,
  Power,
  Rocket,
} from 'lucide-react';
import { useId } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useAppUiPreferences } from '@/hooks/use-app-ui-preferences';
import { api, getErrorMessage, type StartupPage } from '@/lib/api';
import { notifyAction } from '@/lib/notify';
import { flushPendingAppWrites } from '@/lib/pending-app-writes';
import { APP_UI_PREFERENCES_QUERY_KEY } from '@/lib/query-invalidation';
import {
  SettingsBody,
  SettingsCard,
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
  const descriptionId = useId();
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
  const hideMutation = useMutation({
    mutationFn: async () => {
      await flushPendingAppWrites();
      await api.hideMainWindowToTray();
    },
    onError: (error) =>
      notifyAction('Could not hide to tray', {
        detail: getErrorMessage(error),
        tone: 'error',
      }),
  });

  const launchPending = launchQuery.isLoading || launchMutation.isPending;
  const launchEnabled = launchQuery.data === true;
  const trayEnabled = preferences.closeToTray || preferences.minimizeToTray;
  const canStartMinimized = launchEnabled || trayEnabled;
  const startPageLabel =
    START_PAGES.find((option) => option.value === preferences.startupPage)?.label ?? 'Home';

  return (
    <div className='@container/general space-y-8'>
      <SettingsQueryError query={preferencesQuery} message="Couldn't load your preferences." />
      <div className='grid items-start gap-x-5 gap-y-8 @min-[54rem]/general:grid-cols-2'>
        <SettingsGroup>
          <SettingsGroupHeader
            icon={Power}
            title='Startup'
            description='Choose how Stremiro opens.'
          />
          <SettingsCard>
            <SettingsBody rows>
              <SettingsQueryError
                query={launchQuery}
                message='Could not read your login item setting.'
              />
              <SettingsRow icon={House} label='Start page' description='Where Stremiro opens.'>
                <SettingsSelect
                  ariaLabel='Start page'
                  valueLabel={startPageLabel}
                  value={preferences.startupPage}
                  options={START_PAGES}
                  disabled={isHydrating}
                  onChange={(startupPage) => updatePreferences({ startupPage })}
                />
              </SettingsRow>
              <SettingsRow
                icon={Rocket}
                label='Launch at login'
                description='Open Stremiro when you sign in.'
                descriptionId={`${descriptionId}-login`}
              >
                <SettingsSwitch
                  ariaLabel='Launch at login'
                  ariaDescribedBy={`${descriptionId}-login`}
                  checked={launchEnabled}
                  disabled={launchQuery.data === undefined}
                  pending={launchPending}
                  onChange={() => launchMutation.mutate(!launchEnabled)}
                />
              </SettingsRow>
              <SettingsRow
                icon={Minimize2}
                label='Start minimized'
                descriptionId={`${descriptionId}-startup`}
                description={
                  launchEnabled
                    ? 'Start in the tray at login. Manual launches stay visible.'
                    : trayEnabled
                      ? 'Applies to login launches. Turn on Launch at login to use it.'
                      : 'Enable Launch at login or a tray option first.'
                }
              >
                <SettingsSwitch
                  ariaLabel='Start minimized'
                  ariaDescribedBy={`${descriptionId}-startup`}
                  checked={preferences.startMinimized}
                  disabled={isHydrating || (!canStartMinimized && !preferences.startMinimized)}
                  pending={launchMutation.isPending}
                  onChange={() =>
                    updatePreferences({ startMinimized: !preferences.startMinimized })
                  }
                />
              </SettingsRow>
            </SettingsBody>
          </SettingsCard>
        </SettingsGroup>
        <SettingsGroup>
          <SettingsGroupHeader
            icon={AppWindow}
            title='System tray'
            description='Click the tray icon to reopen. Use its menu to quit.'
            action={
              trayEnabled ? (
                <Button
                  variant='ghost'
                  size='sm'
                  disabled={isHydrating || launchMutation.isPending || hideMutation.isPending}
                  aria-busy={hideMutation.isPending || undefined}
                  className='h-8 px-2.5 text-xs text-zinc-400 hover:bg-white/[0.04] hover:text-white'
                  onClick={() => hideMutation.mutate()}
                >
                  Hide to tray
                </Button>
              ) : undefined
            }
          />
          <SettingsCard>
            <SettingsBody rows>
              <SettingsRow
                icon={PanelBottomClose}
                label='Close to tray'
                description='Hide the window and pause playback instead of quitting.'
                descriptionId={`${descriptionId}-close`}
              >
                <SettingsSwitch
                  ariaLabel='Close to tray'
                  ariaDescribedBy={`${descriptionId}-close`}
                  checked={preferences.closeToTray}
                  disabled={isHydrating}
                  pending={launchMutation.isPending}
                  onChange={() => updatePreferences({ closeToTray: !preferences.closeToTray })}
                />
              </SettingsRow>
              <SettingsRow
                icon={PanelBottom}
                label='Minimize to tray'
                description='Hide from the taskbar. Playback keeps running.'
                descriptionId={`${descriptionId}-minimize`}
              >
                <SettingsSwitch
                  ariaLabel='Minimize to tray'
                  ariaDescribedBy={`${descriptionId}-minimize`}
                  checked={preferences.minimizeToTray}
                  disabled={isHydrating}
                  pending={launchMutation.isPending}
                  onChange={() =>
                    updatePreferences({ minimizeToTray: !preferences.minimizeToTray })
                  }
                />
              </SettingsRow>
            </SettingsBody>
          </SettingsCard>
        </SettingsGroup>
      </div>
    </div>
  );
}
