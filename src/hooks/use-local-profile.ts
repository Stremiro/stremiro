import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import {
  type AccentTargets,
  api,
  type LocalProfile,
  type LocalProfileUpdate,
  type ProfilePreferences,
  type ProfilePreferencesPatch,
  type ProfileViewMode,
} from '@/lib/api';
import { runOptimisticQueryMutation } from '@/lib/optimistic-query';
import { trackPendingAppWrite } from '@/lib/pending-app-writes';
import { PROFILE_PREFERENCES_QUERY_KEY } from '@/lib/query-invalidation';

export type { AccentTargets, LocalProfile, LocalProfileUpdate, ProfileViewMode };

const DEFAULT_ACCENT_TARGETS: AccentTargets = {
  navigation: true,
  actions: true,
  progress: true,
  artwork: true,
};

const DEFAULT_PROFILE: LocalProfile = {
  username: 'Guest User',
  accentColor: '#ffffff',
  accentIntensity: 100,
  accentTargets: DEFAULT_ACCENT_TARGETS,
};

const DEFAULT_PROFILE_PREFERENCES: ProfilePreferences = {
  profile: DEFAULT_PROFILE,
  viewMode: 'grid',
};

function useProfilePreferencesQuery<T = ProfilePreferences>(
  select?: (preferences: ProfilePreferences) => T,
) {
  return useQuery({
    queryKey: PROFILE_PREFERENCES_QUERY_KEY,
    queryFn: api.getProfilePreferences,
    staleTime: Infinity,
    gcTime: Infinity,
    placeholderData: DEFAULT_PROFILE_PREFERENCES,
    ...(select ? { select } : {}),
  });
}

const selectProfileAccent = ({ profile }: ProfilePreferences) => ({
  accentColor: profile.accentColor,
  accentIntensity: profile.accentIntensity,
  accentTargets: profile.accentTargets,
});

const FALLBACK_PROFILE_ACCENT: ReturnType<typeof selectProfileAccent> = {
  accentColor: DEFAULT_PROFILE.accentColor,
  accentIntensity: DEFAULT_PROFILE.accentIntensity,
  accentTargets: DEFAULT_PROFILE.accentTargets,
};

/// Accent-only observer for always-mounted chrome (Layout): re-renders only
/// when the accent fields change, not on username or view-mode writes.
export function useProfileAccent(): ReturnType<typeof selectProfileAccent> {
  const profilePreferencesQuery = useProfilePreferencesQuery(selectProfileAccent);
  return profilePreferencesQuery.data ?? FALLBACK_PROFILE_ACCENT;
}

const selectProfileAvatar = (preferences: ProfilePreferences) => {
  const { username, avatar } = preferences.profile;
  return { username, avatar };
};

/// Identity slice for the sidebar's Profile button — accent/view-mode writes
/// leave it untouched.
export function useProfileAvatar(): ReturnType<typeof selectProfileAvatar> | undefined {
  return useProfilePreferencesQuery(selectProfileAvatar).data;
}

export function useLocalProfile() {
  const queryClient = useQueryClient();
  const profilePreferencesQuery = useProfilePreferencesQuery();

  const savePreferencesMutation = useMutation({
    mutationFn: api.saveProfilePreferences,
  });
  const { mutateAsync: saveProfilePrefs } = savePreferencesMutation;

  const currentPreferences = profilePreferencesQuery.data ?? DEFAULT_PROFILE_PREFERENCES;

  const persistPreferences = useCallback(
    (patch: ProfilePreferencesPatch) => {
      const operation = (async () => {
        // Hydrate the optimistic display; Rust applies only the edited fields
        // to the latest persisted profile under the store gate.
        await queryClient.ensureQueryData({
          queryKey: PROFILE_PREFERENCES_QUERY_KEY,
          queryFn: api.getProfilePreferences,
        });
        const latest =
          queryClient.getQueryData<ProfilePreferences>(PROFILE_PREFERENCES_QUERY_KEY) ??
          DEFAULT_PROFILE_PREFERENCES;
        const { viewMode, ...profile } = patch;
        const preferences: ProfilePreferences = {
          viewMode: viewMode ?? latest.viewMode,
          profile: {
            ...latest.profile,
            ...profile,
            accentTargets: { ...latest.profile.accentTargets, ...profile.accentTargets },
          },
        };
        await runOptimisticQueryMutation({
          mutate: saveProfilePrefs,
          optimisticData: preferences,
          queryClient,
          queryKey: PROFILE_PREFERENCES_QUERY_KEY,
          variables: patch,
        });
      })();
      // Track hydration too: a backup can start before the IPC write is queued.
      return trackPendingAppWrite(operation);
    },
    [queryClient, saveProfilePrefs],
  );

  const updateProfile = useCallback(
    (updates: LocalProfileUpdate) => persistPreferences(updates),
    [persistPreferences],
  );

  const updateViewMode = useCallback(
    (viewMode: ProfileViewMode) => persistPreferences({ viewMode }),
    [persistPreferences],
  );

  return {
    profile: currentPreferences.profile,
    viewMode: currentPreferences.viewMode,
    updateProfile,
    updateViewMode,
    isSaving: savePreferencesMutation.isPending,
  };
}
