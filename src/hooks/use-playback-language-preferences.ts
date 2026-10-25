import { type QueryClient, queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import {
  api,
  type PlaybackLanguagePreferences,
  type SavedPlaybackLanguagePreference,
  type TrackLanguageCandidate,
} from '@/lib/api';
import { trackPendingAppWrite } from '@/lib/pending-app-writes';
import {
  effectivePlaybackLanguagePreferencesQueryKey,
  invalidatePlaybackLanguageQueries,
  PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY,
  SUPPORTED_LANGUAGES_QUERY_KEY,
} from '@/lib/query-invalidation';
import { createSerialTaskQueue } from '@/lib/utils';

const PLAYBACK_LANGUAGE_PREFERENCES_STALE_TIME = 1000 * 60 * 5;

// Module-level save queue — the store is global, and reads await it so a refetch can't land over a pending save.
const saveQueue = createSerialTaskQueue();
const pendingLanguagePatches = new Set<PlaybackLanguagePreferences>();

export const playbackLanguagePreferencesQueryOptions = queryOptions({
  queryKey: PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY,
  queryFn: async () => {
    await saveQueue.pending();
    return api.getPlaybackLanguagePreferences();
  },
  staleTime: PLAYBACK_LANGUAGE_PREFERENCES_STALE_TIME,
});

export const supportedLanguagesQueryOptions = queryOptions({
  queryKey: SUPPORTED_LANGUAGES_QUERY_KEY,
  queryFn: api.getSupportedLanguages,
  staleTime: Number.POSITIVE_INFINITY,
});

function enqueueSave(
  queryClient: QueryClient,
  task: () => Promise<SavedPlaybackLanguagePreference>,
  patch?: PlaybackLanguagePreferences,
  effectiveQueryKey?: ReturnType<typeof effectivePlaybackLanguagePreferencesQueryKey>,
) {
  if (patch) {
    pendingLanguagePatches.add(patch);
    void queryClient.cancelQueries({
      queryKey: PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY,
      exact: true,
    });
    queryClient.setQueryData<PlaybackLanguagePreferences>(
      PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY,
      (current) => ({ ...current, ...patch }),
    );
  }
  const queuedSave = saveQueue.enqueue(async () => {
    let seededEffectiveQueryKey: typeof effectiveQueryKey;
    await queryClient.cancelQueries({
      queryKey: PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY,
      exact: true,
    });
    try {
      const { preferences: savedPreferences, effective } = await task();
      if (effective && effectiveQueryKey) {
        await queryClient.cancelQueries({ queryKey: effectiveQueryKey, exact: true });
        queryClient.setQueryData(effectiveQueryKey, effective);
        seededEffectiveQueryKey = effectiveQueryKey;
      }
      if (patch) pendingLanguagePatches.delete(patch);
      const currentPreferences = { ...savedPreferences };
      for (const pending of pendingLanguagePatches) {
        Object.assign(currentPreferences, pending);
      }
      queryClient.setQueryData(PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY, currentPreferences);
      return savedPreferences;
    } catch (error) {
      if (patch) pendingLanguagePatches.delete(patch);
      void queryClient.invalidateQueries({
        queryKey: PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY,
        exact: true,
      });
      throw error;
    } finally {
      await invalidatePlaybackLanguageQueries(queryClient, seededEffectiveQueryKey);
    }
  });
  return trackPendingAppWrite(queuedSave);
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

  const globalPlaybackLanguagePreferencesQuery = useQuery({
    ...playbackLanguagePreferencesQueryOptions,
    enabled: !mediaId,
  });

  // Runs for 'local' too — the scoped merge falls back to global defaults, which local sessions should auto-apply.
  const { data: effectivePlaybackLanguagePreferences } = useQuery({
    queryKey: effectivePlaybackLanguagePreferencesQueryKey(mediaType, mediaId),
    queryFn: () => api.getEffectivePlaybackLanguagePreferences(mediaType, mediaId),
    enabled: !!mediaId,
    staleTime: PLAYBACK_LANGUAGE_PREFERENCES_STALE_TIME,
  });

  const saveGlobalPlaybackLanguagePreference = useCallback(
    (preferenceKind: 'audio' | 'sub', language?: string) => {
      const field =
        preferenceKind === 'audio' ? 'preferredAudioLanguage' : 'preferredSubtitleLanguage';
      return enqueueSave(
        queryClient,
        () =>
          api
            .savePlaybackLanguagePreference(preferenceKind, language)
            .then((preferences) => ({ preferences })),
        { [field]: language },
      );
    },
    [queryClient],
  );

  const saveGlobalPlaybackLanguagePreferenceSelection = useCallback(
    (
      preferenceKind: 'audio' | 'sub',
      track?: TrackLanguageCandidate,
      options?: { subtitlesOff?: boolean },
    ) =>
      enqueueSave(
        queryClient,
        () =>
          api.saveSelectedPlaybackLanguagePreference(preferenceKind, track, {
            subtitlesOff: options?.subtitlesOff,
            mediaType,
            mediaId,
          }),
        undefined,
        effectivePlaybackLanguagePreferencesQueryKey(mediaType, mediaId),
      ),
    [mediaId, mediaType, queryClient],
  );

  return {
    effectivePlaybackLanguagePreferences,
    globalPlaybackLanguagePreferences: globalPlaybackLanguagePreferencesQuery.data,
    globalPlaybackLanguagePreferencesQuery,
    saveGlobalPlaybackLanguagePreference,
    saveGlobalPlaybackLanguagePreferenceSelection,
  };
}
