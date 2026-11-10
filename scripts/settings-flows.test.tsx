import { expect, mock, test } from 'bun:test';
import {
  captureWithClient,
  markupWithClient,
  queryClientFixture,
  restoreSpies,
  spyFixture,
} from './render-helpers';
import * as React from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AccentControls } from '../src/components/accent-controls';
import { ConfirmDialog } from '../src/components/ui/dialog';
import { supportedLanguagesQueryOptions } from '../src/hooks/use-playback-language-preferences';
import { DEFAULT_PROFILE_PREFERENCES } from '../src/hooks/use-local-profile';
import * as localProfile from '../src/hooks/use-local-profile';
import { api, DEFAULT_APP_UI_PREFERENCES } from '../src/lib/api';
import {
  APP_UI_PREFERENCES_QUERY_KEY,
  PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY,
  PROFILE_PREFERENCES_QUERY_KEY,
} from '../src/lib/query-invalidation';
import { DataSection } from '../src/pages/settings/data';
import { PlaybackSettings } from '../src/pages/settings/playback';
import { AppearanceSettings } from '../src/pages/settings/appearance';

type Element = React.ReactElement<Record<string, unknown> & { children?: React.ReactNode }>;

function findElement(tree: React.ReactNode, predicate: (element: Element) => boolean): Element {
  for (const child of React.Children.toArray(tree)) {
    if (!React.isValidElement(child)) continue;
    const element = child as Element;
    if (predicate(element)) return element;
    try {
      return findElement(element.props.children, predicate);
    } catch {
      // Continue with the next sibling.
    }
  }
  throw new Error('Missing settings control');
}

const spyOn = spyFixture();
const createClient = queryClientFixture();
function testClient() {
  const client = createClient({
    defaultOptions: {
      queries: { retry: false, retryOnMount: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
  client.setQueryData(APP_UI_PREFERENCES_QUERY_KEY, DEFAULT_APP_UI_PREFERENCES);
  client.setQueryData(api.dataStatsQueryOptions().queryKey, {
    history_count: 2,
    has_learned_playback_data: false,
    library_count: 2,
    lists_count: 1,
    watch_statuses_count: 2,
  });
  return client;
}

const captureComponent = <T,>(client: QueryClient, component: () => T) =>
  captureWithClient(client, component, '/settings');

function captureDataPart(client: QueryClient, name: 'BackupRestore' | 'DataManager') {
  const element = findElement(
    DataSection(),
    (node) => typeof node.type === 'function' && node.type.name === name,
  );
  const Component = element.type as React.FunctionComponent<typeof element.props>;
  return captureComponent(client, () => Component(element.props));
}

function click(tree: React.ReactNode, label: string) {
  const element = findElement(
    tree,
    (node) => node.props.children === label || node.props['aria-label'] === label,
  );
  (element.props.onClick as () => void)();
}

function dataMarkup(client: QueryClient) {
  return markupWithClient(client, <DataSection />);
}

function expectDataControlsDisabled(client: QueryClient, disabled: boolean) {
  const tags = dataMarkup(client).match(/<button\b[^>]*>/g) ?? [];
  for (const selector of [
    'id="setting-export"',
    'id="setting-import"',
    'aria-label="Clear watch history"',
    'aria-label="Clear library"',
  ]) {
    const tag = tags.find((value) => value.includes(selector));
    expect(tag).toBeDefined();
    expect(tag!.includes('disabled=""')).toBe(disabled);
  }
}

function waitForMutations(client: QueryClient): Promise<void> {
  if (!client.isMutating()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = client.getMutationCache().subscribe(() => {
      if (client.isMutating()) return;
      unsubscribe();
      resolve();
    });
  });
}

test('Backup actions remain exclusive across remounts and unlock after failure', async () => {
  const client = testClient();
  const started = Promise.withResolvers<void>();
  const result = Promise.withResolvers<boolean>();
  const exportFile = spyOn(api, 'exportAppDataToFile').mockImplementation(() => {
    started.resolve();
    return result.promise;
  });
  const importFile = spyOn(api, 'importAppDataFromFile').mockResolvedValue(null);
  const error = spyOn(toast, 'error').mockReturnValue('notice');
  try {
    expectDataControlsDisabled(client, false);
    const controls = captureDataPart(client, 'BackupRestore');
    click(controls, 'Export');
    click(controls, 'Export');
    const previousDialog = findElement(controls, (node) => node.type === ConfirmDialog);
    (previousDialog.props.onConfirm as () => void)();
    await started.promise;
    expectDataControlsDisabled(client, true);
    const remounted = captureDataPart(client, 'BackupRestore');
    click(remounted, 'Export');
    const dialog = findElement(remounted, (node) => node.type === ConfirmDialog);
    (dialog.props.onConfirm as () => void)();
    expect(exportFile).toHaveBeenCalledTimes(1);
    expect(importFile).not.toHaveBeenCalled();
    result.reject(new Error('Disk full'));
    await waitForMutations(client);
    expectDataControlsDisabled(client, false);
    expect(error).toHaveBeenCalledWith('Export failed: Disk full');
  } finally {
    result.resolve(false);
    await waitForMutations(client);
    restoreSpies(exportFile, importFile, error);
  }
});

test('A pending clear also blocks backups until its cache refresh finishes', async () => {
  const client = testClient();
  const started = Promise.withResolvers<void>();
  const result = Promise.withResolvers<void>();
  const clear = spyOn(api, 'clearWatchHistory').mockImplementation(() => {
    started.resolve();
    return result.promise;
  });
  const useState = React.useState;
  // Model the already-armed history row; other hooks retain their real state.
  const armed = spyOn(React, 'useState').mockImplementation((initial) =>
    initial === null ? ['history', () => {}] : useState(initial),
  );
  try {
    const controls = captureDataPart(client, 'DataManager');
    armed.mockRestore();
    click(controls, 'Clear permanently: watch history');
    click(controls, 'Clear permanently: watch history');
    await started.promise;
    expectDataControlsDisabled(client, true);
    result.resolve();
    await waitForMutations(client);
    expectDataControlsDisabled(client, false);
    expect(clear).toHaveBeenCalledTimes(1);
  } finally {
    armed.mockRestore();
    result.resolve();
    await waitForMutations(client);
    clear.mockRestore();
  }
});

test.each([
  ['preferences', true],
  ['languages', false],
] as const)(
  'Playback language controls survive a failed %s query (cached=%s)',
  async (failedQuery, cached) => {
    const client = testClient();
    if (cached) {
      client.setQueryData(PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY, {
        preferredAudioLanguage: 'en',
        preferredSubtitleLanguage: 'off',
      });
      client.setQueryData(supportedLanguagesQueryOptions.queryKey, [
        { code: 'en', label: 'English' },
      ]);
    }
    const queryKey =
      failedQuery === 'preferences'
        ? PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY
        : supportedLanguagesQueryOptions.queryKey;
    await client
      .fetchQuery({
        queryKey,
        queryFn: () => Promise.reject(new Error('Offline')),
        staleTime: 0,
      })
      .catch(() => {});
    const markup = markupWithClient(client, <PlaybackSettings />);
    expect(markup).toContain('Couldn&#x27;t load playback languages.');
    expect(markup).toContain('id="setting-audio"');
    expect(markup).toContain(`aria-label="Audio: ${cached ? 'English' : 'Unavailable'}"`);
    expect(markup).toContain(`aria-label="Subtitles: ${cached ? 'Off' : 'Unavailable'}"`);
    if (!cached) {
      const tags = markup.match(/<button\b[^>]*>/g) ?? [];
      expect(tags.find((tag) => tag.includes('aria-label="Audio: Unavailable"'))).toContain(
        'disabled=""',
      );
    }
  },
);

function accentControls(tree: React.ReactNode) {
  return findElement(tree, (node) => node.type === AccentControls).props as React.ComponentProps<
    typeof AccentControls
  >;
}

test('Reset and reselecting a color keeps the newer draft when an older save finishes', async () => {
  const client = testClient();
  client.setQueryData(PROFILE_PREFERENCES_QUERY_KEY, DEFAULT_PROFILE_PREFERENCES);
  let base = {} as ReturnType<typeof localProfile.useLocalProfile>;
  void captureWithClient(client, () => {
    base = localProfile.useLocalProfile();
    return null;
  });
  let profile = base.profile;
  const firstSave = Promise.withResolvers<void>();
  const colors: string[] = [];
  const save = mock((patch: Parameters<typeof base.updateProfile>[0]) => {
    profile = { ...profile, ...patch };
    if (patch.accentColor) colors.push(patch.accentColor);
    return colors.length === 1 ? firstSave.promise : Promise.resolve();
  });
  const profileHook = spyOn(localProfile, 'useLocalProfile').mockImplementation(() => ({
    ...base,
    profile,
    updateProfile: save,
  }));
  const states: unknown[] = [];
  const refs: { current: unknown }[] = [];
  let stateIndex = 0;
  let refIndex = 0;
  const state = spyOn(React, 'useState').mockImplementation((initial) => {
    const index = stateIndex++;
    if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
    return [
      states[index],
      (next: React.SetStateAction<unknown>) => {
        states[index] = typeof next === 'function' ? next(states[index]) : next;
      },
    ];
  });
  const ref = spyOn(React, 'useRef').mockImplementation((initial) => {
    const index = refIndex++;
    return (refs[index] ??= { current: initial });
  });
  const render = () => {
    stateIndex = 0;
    refIndex = 0;
    return captureComponent(client, AppearanceSettings);
  };
  try {
    accentControls(render()).onAccentColorChange('#abc');
    const draftHeader = findElement(render(), (node) => node.props.title === 'Color & glow');
    expect((draftHeader.props.action as Element).props['aria-disabled']).toBeUndefined();
    accentControls(render()).onAccentColorChange('#123456');
    const olderSave = accentControls(render()).onAccentColorCommit!('#123456');
    const header = findElement(render(), (node) => node.props.title === 'Color & glow');
    const reset = header.props.action as Element;
    (reset.props.onClick as () => void)();
    await accentControls(render()).onAccentColorCommit!('#123456');
    expect(colors).toEqual(['#123456', '#ffffff']);
    accentControls(render()).onAccentColorChange('#123456');
    firstSave.resolve();
    await olderSave;
    await accentControls(render()).onAccentColorCommit!('#123456');
    expect(colors).toEqual(['#123456', '#ffffff', '#123456']);
  } finally {
    firstSave.resolve();
    restoreSpies(state, ref, profileHook);
  }
});
