import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';

import { api, type PlaybackLanguagePreferences, type TrackLanguageCandidate } from '@/lib/api';
import { registerPendingAppWriteFlusher, trackPendingAppWrite } from '@/lib/pending-app-writes';
import {
  effectivePlaybackLanguagePreferencesQueryKey,
  invalidatePlaybackLanguageQueries,
  PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY,
} from '@/lib/query-invalidation';

const PLAYBACK_LANGUAGE_PREFERENCES_STALE_TIME = 1000 * 60 * 5;

// The persisted store is global, so the write serialization and the
// latest-known snapshot are module-level: two mounted consumers must not
// run interleaved saves built from divergent per-instance refs.
let globalPlaybackPreferences: PlaybackLanguagePreferences = {};
let globalPlaybackPreferencesHydrated = false;
let saveQueue = Promise.resolve<PlaybackLanguagePreferences | undefined>(undefined);

function enqueueSave(queryClient: QueryClient, task: () => Promise<PlaybackLanguagePreferences>) {
  const queuedSave = saveQueue.then(async () => {
    await queryClient.cancelQueries({
      queryKey: PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY,
      exact: true,
    });
    const savedPreferences = await task();
    globalPlaybackPreferences = savedPreferences;
    globalPlaybackPreferencesHydrated = true;
    queryClient.setQueryData(PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY, savedPreferences);
    await invalidatePlaybackLanguageQueries(queryClient);
    return savedPreferences;
  });
  saveQueue = queuedSave.catch(() => undefined);
  // The internal queue recovers so later saves keep serializing; the raw
  // operation is what the app barrier tracks for strict settlement.
  return trackPendingAppWrite(queuedSave);
}

export async function flushPendingPlaybackLanguagePreferences(): Promise<void> {
  await saveQueue;
}
registerPendingAppWriteFlusher(flushPendingPlaybackLanguagePreferences);

/// Drop the module snapshot when durable state changed out-of-band (backup
/// restore): the next save must re-hydrate instead of composing a
/// whole-snapshot write over the imported values.
export function resetPlaybackLanguagePreferencesSnapshot() {
  globalPlaybackPreferences = {};
  globalPlaybackPreferencesHydrated = false;
}

interface UsePlaybackLanguagePreferencesOptions {
  mediaId?: string;
  mediaType?: 'movie' | 'series' | 'anime';
}

export function usePlaybackLanguagePreferences({
  mediaId,
  mediaType,
}: UsePlaybackLanguagePreferencesOptions = {}) {
  const queryClient = useQueryClient();

  const {
    data: fetchedGlobalPlaybackLanguagePreferences,
    isLoading: isLoadingGlobalPlaybackLanguagePreferences,
  } = useQuery({
    queryKey: PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY,
    queryFn: async () => {
      await saveQueue;
      return api.getPlaybackLanguagePreferences();
    },
    staleTime: PLAYBACK_LANGUAGE_PREFERENCES_STALE_TIME,
  });

  useEffect(() => {
    if (!fetchedGlobalPlaybackLanguagePreferences) {
      return;
    }

    globalPlaybackPreferences = fetchedGlobalPlaybackLanguagePreferences;
    globalPlaybackPreferencesHydrated = true;
  }, [fetchedGlobalPlaybackLanguagePreferences]);

  const { data: effectivePlaybackLanguagePreferences } = useQuery({
    queryKey: effectivePlaybackLanguagePreferencesQueryKey(mediaType, mediaId),
    queryFn: () => api.getEffectivePlaybackLanguagePreferences(mediaId, mediaType),
    enabled: !!mediaId && mediaId !== 'local',
    staleTime: PLAYBACK_LANGUAGE_PREFERENCES_STALE_TIME,
  });

  const saveGlobalPlaybackLanguagePreferences = useCallback(
    (patch: Partial<PlaybackLanguagePreferences>) =>
      enqueueSave(queryClient, async () => {
        if (!globalPlaybackPreferencesHydrated) {
          const cached = queryClient.getQueryData<PlaybackLanguagePreferences>(
            PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY,
          );
          globalPlaybackPreferences = cached ?? (await api.getPlaybackLanguagePreferences());
          globalPlaybackPreferencesHydrated = true;
        }

        // Spread preserves explicit `undefined` keys, so a cleared field still writes.
        const nextPreferences = { ...globalPlaybackPreferences, ...patch };

        return api.savePlaybackLanguagePreferences(
          nextPreferences.preferredAudioLanguage,
          nextPreferences.preferredSubtitleLanguage,
        );
      }),
    [queryClient],
  );

  const saveGlobalPlaybackLanguagePreferenceSelection = useCallback(
    (
      preferenceKind: 'audio' | 'sub',
      track?: TrackLanguageCandidate,
      options?: { subtitlesOff?: boolean },
    ) =>
      enqueueSave(queryClient, () =>
        api.saveSelectedPlaybackLanguagePreference(preferenceKind, track, options?.subtitlesOff),
      ),
    [queryClient],
  );

  return {
    effectivePlaybackLanguagePreferences,
    globalPlaybackLanguagePreferences: fetchedGlobalPlaybackLanguagePreferences,
    isLoadingGlobalPlaybackLanguagePreferences,
    saveGlobalPlaybackLanguagePreferences,
    saveGlobalPlaybackLanguagePreferenceSelection,
  };
}
