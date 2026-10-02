import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { api, type PlaybackLanguagePreferences, type TrackLanguageCandidate } from '@/lib/api';
import { registerPendingAppWriteFlusher, trackPendingAppWrite } from '@/lib/pending-app-writes';
import {
  effectivePlaybackLanguagePreferencesQueryKey,
  invalidatePlaybackLanguageQueries,
  PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY,
} from '@/lib/query-invalidation';

const PLAYBACK_LANGUAGE_PREFERENCES_STALE_TIME = 1000 * 60 * 5;

// The persisted store is global, so write serialization is module-level:
// the query read awaits this queue so a refetch never lands over a pending
// save with stale store values.
let saveQueue = Promise.resolve<PlaybackLanguagePreferences | undefined>(undefined);
const pendingLanguagePatches = new Set<PlaybackLanguagePreferences>();

function enqueueSave(
  queryClient: QueryClient,
  task: () => Promise<PlaybackLanguagePreferences>,
  patch?: PlaybackLanguagePreferences,
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
  const queuedSave = saveQueue.then(async () => {
    await queryClient.cancelQueries({
      queryKey: PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY,
      exact: true,
    });
    let savedPreferences: PlaybackLanguagePreferences;
    try {
      savedPreferences = await task();
    } catch (error) {
      if (patch) pendingLanguagePatches.delete(patch);
      void queryClient.invalidateQueries({
        queryKey: PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY,
        exact: true,
      });
      throw error;
    }
    if (patch) pendingLanguagePatches.delete(patch);
    const currentPreferences = { ...savedPreferences };
    for (const pending of pendingLanguagePatches) {
      Object.assign(currentPreferences, pending);
    }
    queryClient.setQueryData(PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY, currentPreferences);
    await invalidatePlaybackLanguageQueries(queryClient);
    return savedPreferences;
  });
  saveQueue = queuedSave.catch(() => undefined);
  // The internal queue recovers so later saves keep serializing; the raw
  // operation is what the app barrier tracks for strict settlement.
  return trackPendingAppWrite(queuedSave);
}

registerPendingAppWriteFlusher(async () => {
  await saveQueue;
});

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

  const { data: effectivePlaybackLanguagePreferences } = useQuery({
    queryKey: effectivePlaybackLanguagePreferencesQueryKey(mediaType, mediaId),
    queryFn: () => api.getEffectivePlaybackLanguagePreferences(mediaId, mediaType),
    enabled: !!mediaId && mediaId !== 'local',
    staleTime: PLAYBACK_LANGUAGE_PREFERENCES_STALE_TIME,
  });

  const saveGlobalPlaybackLanguagePreference = useCallback(
    (preferenceKind: 'audio' | 'sub', language?: string) => {
      const field =
        preferenceKind === 'audio' ? 'preferredAudioLanguage' : 'preferredSubtitleLanguage';
      const current = queryClient.getQueryData<PlaybackLanguagePreferences>(
        PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY,
      );
      // The cache includes queued picks, not just the last native acknowledgement.
      if (current && current[field] === language) return;
      return enqueueSave(
        queryClient,
        () => api.savePlaybackLanguagePreference(preferenceKind, language),
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
      enqueueSave(queryClient, () =>
        api.saveSelectedPlaybackLanguagePreference(preferenceKind, track, options?.subtitlesOff),
      ),
    [queryClient],
  );

  return {
    effectivePlaybackLanguagePreferences,
    globalPlaybackLanguagePreferences: fetchedGlobalPlaybackLanguagePreferences,
    isLoadingGlobalPlaybackLanguagePreferences,
    saveGlobalPlaybackLanguagePreference,
    saveGlobalPlaybackLanguagePreferenceSelection,
  };
}
