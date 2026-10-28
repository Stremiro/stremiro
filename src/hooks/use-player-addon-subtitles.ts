import { useQuery } from '@tanstack/react-query';
import { type RefObject, useEffect, useEffectEvent, useRef, useState } from 'react';
import { toast } from 'sonner';

import type { PlayerOsdMessageIcon } from '@/components/player-osd-overlay';
import { type AddonSubtitle, api, getErrorMessage } from '@/lib/api';
import { isExternalSubtitleTrack, type Track, trackDisplayLabel } from '@/lib/player-track-utils';
import { addonSubtitlesQueryKey } from '@/lib/query-invalidation';
import { nonBlank } from '@/lib/utils';

// Stable fallback so `?? []` never changes memo identity per render.
const EMPTY_ADDON_SUBTITLES: AddonSubtitle[] = [];

interface UsePlayerAddonSubtitlesOptions {
  activeStreamLoadKey: string;
  announce: (text: string, icon?: PlayerOsdMessageIcon) => void;
  /** Preferred language no embedded track matches; loads the best addon subtitle once per language and stream load. */
  autoLoadLanguage: string | null;
  effectiveResolveMediaType: string;
  id?: string;
  menuAvailable: boolean;
  mountedRef: RefObject<boolean>;
  resolvedStreamEpisode?: number;
  resolvedStreamSeason?: number;
  selectAddonSubtitle: (
    subtitle: AddonSubtitle,
    options?: { automatic?: boolean },
  ) => Promise<boolean>;
  setTrack: (
    type: 'sub',
    id: number | 'no',
    options?: { silent?: boolean; persistPreference?: boolean },
  ) => Promise<boolean>;
  streamLookupId?: string;
  subTracks: Track[];
}

export function usePlayerAddonSubtitles({
  activeStreamLoadKey,
  announce,
  autoLoadLanguage,
  effectiveResolveMediaType,
  id,
  menuAvailable,
  mountedRef,
  resolvedStreamEpisode,
  resolvedStreamSeason,
  selectAddonSubtitle,
  setTrack,
  streamLookupId,
  subTracks,
}: UsePlayerAddonSubtitlesOptions) {
  const [pickedAddonSubtitleId, setPickedAddonSubtitleId] = useState<string | null>(null);
  const [addonSubtitleLoadingId, setAddonSubtitleLoadingId] = useState<string | null>(null);
  const [subtitleMenuOpened, setSubtitleMenuOpened] = useState(false);
  const subtitleSessionEpochRef = useRef(0);
  const autoLoadedLanguageRef = useRef<string | null>(null);

  // External tracks die with each native load, including same-URL credential swaps.
  useEffect(() => {
    subtitleSessionEpochRef.current += 1;
    setPickedAddonSubtitleId(null);
    setAddonSubtitleLoadingId(null);
    autoLoadedLanguageRef.current = null;
    return () => {
      subtitleSessionEpochRef.current += 1;
    };
  }, [activeStreamLoadKey]);

  useEffect(() => {
    if (!menuAvailable) setSubtitleMenuOpened(false);
  }, [menuAvailable]);

  // Trimmed so the query key matches what the API sends — untrimmed keys would fork the cache entry.
  const lookupMediaType = effectiveResolveMediaType.trim();
  const lookupMediaId = nonBlank(streamLookupId) ?? nonBlank(id);
  const subtitlesEnabled =
    ((menuAvailable && subtitleMenuOpened) || autoLoadLanguage !== null) &&
    lookupMediaType !== '' &&
    !!lookupMediaId;

  const subtitlesQuery = useQuery({
    queryKey: addonSubtitlesQueryKey(
      lookupMediaType || undefined,
      lookupMediaId,
      resolvedStreamSeason,
      resolvedStreamEpisode,
    ),
    queryFn: () => {
      if (!lookupMediaType || !lookupMediaId) throw new Error('Missing media identity');
      return api.getAddonSubtitles(
        lookupMediaType,
        lookupMediaId,
        resolvedStreamSeason,
        resolvedStreamEpisode,
      );
    },
    enabled: subtitlesEnabled,
    // Reopening rechecks Rust's cache without extending signed-link or empty-result lifetimes.
    staleTime: 0,
    retry: 1,
  });

  const addonSubtitles: AddonSubtitle[] = subtitlesQuery.data ?? EMPTY_ADDON_SUBTITLES;
  // Keep the retry notice mounted while an initial error is retried.
  const addonSubtitlesError =
    subtitlesEnabled &&
    (subtitlesQuery.isError || (subtitlesQuery.isFetched && subtitlesQuery.isLoading))
      ? getErrorMessage(subtitlesQuery.error || "Couldn't load addon subtitles.")
      : undefined;

  const handleSelectAddonSubtitle = async (
    subtitle: AddonSubtitle,
    { automatic }: { automatic?: boolean } = {},
  ) => {
    if (addonSubtitleLoadingId || !mountedRef.current) return;
    const subtitleKey = subtitle.selectionKey;
    const epoch = subtitleSessionEpochRef.current;
    setAddonSubtitleLoadingId(subtitleKey);
    return (async () => {
      // The track controller owns the mpv side: URL reuse, single-switch gate, fetch polling, preference persistence.
      const selected = await selectAddonSubtitle(subtitle, { automatic });
      if (!mountedRef.current || epoch !== subtitleSessionEpochRef.current) return;
      if (!selected) {
        if (!automatic) toast.error('Failed to load addon subtitle');
        return;
      }
      setPickedAddonSubtitleId(subtitleKey);
      if (!automatic) announce(`Subtitles: ${nonBlank(subtitle.label) || 'External'}`, 'subtitles');
    })().finally(() => {
      if (mountedRef.current && epoch === subtitleSessionEpochRef.current) {
        setAddonSubtitleLoadingId(null);
      }
    });
  };

  // A manual pick clears `autoLoadLanguage`, so a late resolution never overrides it.
  const selectAutoLoadedSubtitle = useEffectEvent(
    (subtitle: AddonSubtitle, streamLoadKey: string, language: string) => {
      if (autoLoadLanguage === language && streamLoadKey === activeStreamLoadKey) {
        void handleSelectAddonSubtitle(subtitle, { automatic: true });
      }
    },
  );

  const loadedAddonSubtitles =
    subtitlesQuery.isSuccess && !subtitlesQuery.isFetching ? subtitlesQuery.data : undefined;
  useEffect(() => {
    if (
      !autoLoadLanguage ||
      !loadedAddonSubtitles?.length ||
      autoLoadedLanguageRef.current === autoLoadLanguage
    )
      return;
    autoLoadedLanguageRef.current = autoLoadLanguage;
    const epoch = subtitleSessionEpochRef.current;
    void api
      .resolvePreferredTrackSelection(
        loadedAddonSubtitles.map((subtitle, index) => ({
          id: index,
          lang: subtitle.lang,
          title: subtitle.label,
        })),
        autoLoadLanguage,
      )
      .then(({ matchedTrackId }) => {
        const subtitle =
          matchedTrackId === undefined ? undefined : loadedAddonSubtitles[matchedTrackId];
        if (subtitle && epoch === subtitleSessionEpochRef.current) {
          selectAutoLoadedSubtitle(subtitle, activeStreamLoadKey, autoLoadLanguage);
        }
      })
      .catch(() => undefined);
  }, [activeStreamLoadKey, autoLoadLanguage, loadedAddonSubtitles]);

  const handleSubTrackSelect = (trackId: number | 'no') => {
    const epoch = subtitleSessionEpochRef.current;
    void setTrack('sub', trackId, { persistPreference: true }).then((applied) => {
      if (!applied || !mountedRef.current || epoch !== subtitleSessionEpochRef.current) return;
      announce(
        trackId === 'no' ? 'Subtitles off' : `Subtitles: ${trackDisplayLabel(subTracks, trackId)}`,
        'subtitles',
      );
    });
  };

  // Checkmark derives from mpv truth (one selected sid), so the row follows the
  // selected external track; the explicit pick only disambiguates rows matching the same track.
  const selectedExternal = subTracks.find(
    (track) => track.type === 'sub' && track.selected && track.external,
  );
  const activeAddonMatches = selectedExternal
    ? addonSubtitles.filter((subtitle) => isExternalSubtitleTrack(selectedExternal, subtitle))
    : [];
  const activeAddonSubtitleId =
    activeAddonMatches.length === 0
      ? null
      : activeAddonMatches.some((subtitle) => subtitle.selectionKey === pickedAddonSubtitleId)
        ? pickedAddonSubtitleId
        : activeAddonMatches[0].selectionKey;

  return {
    activeAddonSubtitleId,
    addonSubtitleLoadingId,
    addonSubtitles,
    addonSubtitlesError,
    addonSubtitlesFetching: subtitlesQuery.isFetching && subtitlesEnabled,
    addonSubtitlesLoading: subtitlesQuery.isLoading && subtitlesEnabled,
    addonSubtitlesAvailable: subtitlesEnabled,
    handleAddonSubtitleSelect: handleSelectAddonSubtitle,
    handleSubTrackSelect,
    handleSubtitleMenuOpenChange: (open: boolean) => {
      setSubtitleMenuOpened(open);
      if (open && subtitlesEnabled) void subtitlesQuery.refetch({ cancelRefetch: false });
    },
    refetchAddonSubtitles: subtitlesQuery.refetch,
  };
}
