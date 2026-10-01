import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import {
  type AccentTargets,
  api,
  type LocalProfile,
  type ProfilePreferences,
  type ProfileViewMode,
} from '@/lib/api';
import { runOptimisticQueryMutation } from '@/lib/optimistic-query';
import { registerPendingAppWriteFlusher, settlePendingAppWrites } from '@/lib/pending-app-writes';
import { PROFILE_PREFERENCES_QUERY_KEY } from '@/lib/query-invalidation';
import { HEX_COLOR_PATTERN } from '@/lib/utils';

export type { AccentTargets, LocalProfile, ProfileViewMode };

export type LocalProfileUpdate = Partial<Omit<LocalProfile, 'accentTargets'>> & {
  accentTargets?: Partial<AccentTargets>;
};

const PROFILE_NAME_MAX_LENGTH = 32;
const PROFILE_ACCENT_INTENSITY_DEFAULT = 100;
// Mirrors Rust `normalize_profile_avatar` (prefix allowlist + size cap).
const PROFILE_AVATAR_MAX_LENGTH = 512 * 1024;
const PROFILE_AVATAR_PATTERN = /^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/;
const pendingProfileWrites = new Set<Promise<void>>();

export async function flushPendingProfilePreferences(): Promise<void> {
  await settlePendingAppWrites(pendingProfileWrites);
}
registerPendingAppWriteFlusher(flushPendingProfilePreferences);

const DEFAULT_ACCENT_TARGETS: AccentTargets = {
  navigation: true,
  actions: true,
  progress: true,
  artwork: true,
};

const DEFAULT_PROFILE: LocalProfile = {
  username: 'Guest User',
  accentColor: '#ffffff',
  accentIntensity: PROFILE_ACCENT_INTENSITY_DEFAULT,
  accentTargets: DEFAULT_ACCENT_TARGETS,
};

const DEFAULT_PROFILE_PREFERENCES: ProfilePreferences = {
  profile: DEFAULT_PROFILE,
  viewMode: 'grid',
};

function sanitizeProfile(value: unknown): LocalProfile {
  const raw =
    typeof value === 'object' && value !== null
      ? (value as Partial<Record<keyof LocalProfile, unknown>>)
      : {};

  const username =
    typeof raw.username === 'string' && raw.username.trim().length > 0
      ? raw.username.trim().slice(0, PROFILE_NAME_MAX_LENGTH)
      : DEFAULT_PROFILE.username;
  const avatar =
    typeof raw.avatar === 'string' &&
    raw.avatar.length <= PROFILE_AVATAR_MAX_LENGTH &&
    PROFILE_AVATAR_PATTERN.test(raw.avatar)
      ? raw.avatar
      : undefined;

  return {
    username,
    ...sanitizeProfileAccent(raw),
    ...(avatar ? { avatar } : {}),
  };
}

function sanitizeProfileAccent(raw: Partial<Record<keyof LocalProfile, unknown>>) {
  return {
    accentColor:
      typeof raw.accentColor === 'string' && HEX_COLOR_PATTERN.test(raw.accentColor.trim())
        ? raw.accentColor.trim().toLowerCase()
        : DEFAULT_PROFILE.accentColor,
    accentIntensity:
      typeof raw.accentIntensity === 'number' && Number.isFinite(raw.accentIntensity)
        ? Math.max(0, Math.min(100, Math.round(raw.accentIntensity)))
        : DEFAULT_PROFILE.accentIntensity,
    accentTargets: sanitizeAccentTargets(raw.accentTargets),
  };
}

function sanitizeAccentTargets(value: unknown): AccentTargets {
  const raw =
    typeof value === 'object' && value !== null
      ? (value as Partial<Record<keyof AccentTargets, unknown>>)
      : {};
  return {
    navigation: typeof raw.navigation === 'boolean' ? raw.navigation : true,
    actions: typeof raw.actions === 'boolean' ? raw.actions : true,
    progress: typeof raw.progress === 'boolean' ? raw.progress : true,
    artwork: typeof raw.artwork === 'boolean' ? raw.artwork : true,
  };
}

function sanitizeViewMode(value: unknown): ProfileViewMode {
  return value === 'list' ? 'list' : 'grid';
}

function sanitizeProfilePreferences(value: unknown): ProfilePreferences {
  const raw =
    typeof value === 'object' && value !== null
      ? (value as Partial<Record<keyof ProfilePreferences, unknown>>)
      : {};

  return {
    profile: sanitizeProfile(raw.profile),
    viewMode: sanitizeViewMode(raw.viewMode),
  };
}

function useProfilePreferencesQuery<T>(select?: (preferences: ProfilePreferences) => T) {
  return useQuery({
    queryKey: PROFILE_PREFERENCES_QUERY_KEY,
    queryFn: api.getProfilePreferences,
    staleTime: Infinity,
    gcTime: Infinity,
    placeholderData: DEFAULT_PROFILE_PREFERENCES,
    ...(select ? { select } : {}),
  });
}

const selectProfileAccent = (preferences: ProfilePreferences) =>
  sanitizeProfileAccent(preferences.profile ?? {});

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
  const { username, avatar } = sanitizeProfile(preferences.profile);
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
    mutationFn: (preferences: ProfilePreferences) =>
      api.saveProfilePreferences(preferences.profile, preferences.viewMode),
  });
  const { mutateAsync: saveProfilePrefs } = savePreferencesMutation;

  // Memoized: a fresh preferences/profile object per render defeats memo()
  // on consumers like MediaCard (onToggleLibrary) and profile consumers.
  const currentPreferences = useMemo(
    () => sanitizeProfilePreferences(profilePreferencesQuery.data ?? DEFAULT_PROFILE_PREFERENCES),
    [profilePreferencesQuery.data],
  );

  const persistPreferences = useCallback(
    (update: (preferences: ProfilePreferences) => ProfilePreferences) => {
      const operation = (async () => {
        // Placeholders are display-only: hydrate before composing a full-profile
        // write, and read again after the await so rapid edits build on each other.
        await queryClient.ensureQueryData({
          queryKey: PROFILE_PREFERENCES_QUERY_KEY,
          queryFn: api.getProfilePreferences,
        });
        const latest = sanitizeProfilePreferences(
          queryClient.getQueryData<ProfilePreferences>(PROFILE_PREFERENCES_QUERY_KEY),
        );
        const sanitized = sanitizeProfilePreferences(update(latest));
        await runOptimisticQueryMutation({
          mutate: saveProfilePrefs,
          optimisticData: sanitized,
          queryClient,
          queryKey: PROFILE_PREFERENCES_QUERY_KEY,
          variables: sanitized,
        });
      })();
      // Track hydration too: a backup can start before the IPC write is queued.
      pendingProfileWrites.add(operation);
      const cleanup = () => pendingProfileWrites.delete(operation);
      void operation.then(cleanup, cleanup);
      return operation;
    },
    [queryClient, saveProfilePrefs],
  );

  // Targets merge per flag: two toggles in one tick must not clobber each
  // other with a render-time snapshot of the whole object.
  const updateProfile = useCallback(
    (updates: LocalProfileUpdate) => {
      return persistPreferences((latest) => ({
        ...latest,
        profile: {
          ...latest.profile,
          ...updates,
          accentTargets: { ...latest.profile.accentTargets, ...updates.accentTargets },
        },
      }));
    },
    [persistPreferences],
  );

  const updateViewMode = useCallback(
    (viewMode: ProfileViewMode) =>
      persistPreferences((latest) => ({
        ...latest,
        viewMode,
      })),
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
