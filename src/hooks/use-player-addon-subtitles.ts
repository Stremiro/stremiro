import { useQuery } from '@tanstack/react-query';
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import type { PlayerOsdMessageIcon } from '@/components/player-osd-overlay';
import { type AddonSubtitle, api, getErrorMessage } from '@/lib/api';
import { buildTrackLabelMap, isExternalSubtitleTrack, type Track } from '@/lib/player-track-utils';
import { addonSubtitlesQueryKey } from '@/lib/query-invalidation';
import { nonBlank } from '@/lib/utils';

// Stable fallback so `?? []` never changes memo identity per render.
const EMPTY_ADDON_SUBTITLES: AddonSubtitle[] = [];

interface UsePlayerAddonSubtitlesOptions {
  activeStreamUrl?: string;
  announce: (text: string, icon?: PlayerOsdMessageIcon) => void;
  effectiveResolveMediaType: string;
  id?: string;
  menuAvailable: boolean;
  mountedRef: RefObject<boolean>;
  resolvedStreamEpisode?: number;
  resolvedStreamSeason?: number;
  selectAddonSubtitle: (subtitle: AddonSubtitle) => Promise<boolean>;
  setTrack: (
    type: 'sub',
    id: number | 'no',
    options?: { silent?: boolean; persistPreference?: boolean },
  ) => Promise<boolean>;
  streamLookupId?: string;
  subTracks: Track[];
}

export function usePlayerAddonSubtitles({
  activeStreamUrl,
  announce,
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

  // External tracks die with the stream, so addon-sub identity resets on each new active URL.
  useEffect(() => {
    subtitleSessionEpochRef.current += 1;
    setPickedAddonSubtitleId(null);
    setAddonSubtitleLoadingId(null);
    return () => {
      subtitleSessionEpochRef.current += 1;
    };
  }, [activeStreamUrl]);

  useEffect(() => {
    if (!menuAvailable) setSubtitleMenuOpened(false);
  }, [menuAvailable]);

  // Trimmed so the query key matches what the API sends — untrimmed keys would fork the cache entry.
  const lookupMediaType = effectiveResolveMediaType.trim();
  const lookupMediaId = (streamLookupId || id)?.trim();
  const subtitlesEnabled =
    menuAvailable && subtitleMenuOpened && lookupMediaType !== '' && !!lookupMediaId;

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
    staleTime: 1000 * 60 * 10,
    retry: 1,
  });

  const addonSubtitles: AddonSubtitle[] = subtitlesQuery.data ?? EMPTY_ADDON_SUBTITLES;
  const addonSubtitlesLoading = subtitlesQuery.isLoading && subtitlesEnabled;
  // `isError` only after retries exhaust; a disabled query never reports.
  const addonSubtitlesError =
    subtitlesEnabled && subtitlesQuery.isError ? getErrorMessage(subtitlesQuery.error) : undefined;
  // Distinguishes "asked, got nothing" from "never asked" — gates the empty-state hint.
  const addonSubtitlesQueried = subtitlesEnabled;

  const handleSelectAddonSubtitle = useCallback(
    async (subtitle: AddonSubtitle) => {
      if (addonSubtitleLoadingId || !mountedRef.current) return;
      const subtitleKey = subtitle.selectionKey;
      const epoch = subtitleSessionEpochRef.current;
      setAddonSubtitleLoadingId(subtitleKey);
      try {
        // The track controller owns the mpv side: URL reuse, single-switch gate, fetch polling, preference persistence.
        const selected = await selectAddonSubtitle(subtitle);
        if (!mountedRef.current || epoch !== subtitleSessionEpochRef.current) return;
        if (!selected) {
          toast.error('Failed to load addon subtitle');
          return;
        }
        setPickedAddonSubtitleId(subtitleKey);
        announce(`Subtitles: ${nonBlank(subtitle.label) || 'External'}`, 'subtitles');
      } finally {
        if (mountedRef.current && epoch === subtitleSessionEpochRef.current) {
          setAddonSubtitleLoadingId(null);
        }
      }
    },
    [addonSubtitleLoadingId, announce, mountedRef, selectAddonSubtitle],
  );

  // Stable callback — the controls overlay re-renders per time update, so inline closures would defeat its memo.
  const handleSubTrackSelect = useCallback(
    (trackType: 'sub', trackId: number | 'no', options?: { persistPreference?: boolean }) => {
      const epoch = subtitleSessionEpochRef.current;
      void setTrack(trackType, trackId, options).then((applied) => {
        if (!applied || !mountedRef.current || epoch !== subtitleSessionEpochRef.current) return;
        const label =
          trackId === 'no'
            ? 'Subtitles off'
            : `Subtitles: ${buildTrackLabelMap(subTracks).get(trackId) ?? `Track ${trackId}`}`;
        announce(label, 'subtitles');
      });
    },
    [announce, mountedRef, setTrack, subTracks],
  );

  // Menu-open state follows the popover: a closed menu stops refetch eligibility while cached data still paints on reopen.

  // Checkmark derives from mpv truth (one selected sid), so the row follows the
  // selected external track; the explicit pick only disambiguates rows matching the same track.
  const activeAddonSubtitleId = useMemo(() => {
    const selectedExternal = subTracks.find(
      (track) => track.type === 'sub' && track.selected && track.external,
    );
    if (!selectedExternal) return null;
    const matches = addonSubtitles.filter((subtitle) =>
      isExternalSubtitleTrack(selectedExternal, subtitle),
    );
    if (matches.length === 0) return null;
    return matches.some((subtitle) => subtitle.selectionKey === pickedAddonSubtitleId)
      ? pickedAddonSubtitleId
      : matches[0].selectionKey;
  }, [addonSubtitles, pickedAddonSubtitleId, subTracks]);

  return {
    activeAddonSubtitleId,
    addonSubtitleLoadingId,
    addonSubtitles,
    addonSubtitlesError,
    addonSubtitlesLoading,
    addonSubtitlesQueried,
    handleAddonSubtitleSelect: handleSelectAddonSubtitle,
    handleSubTrackSelect,
    handleSubtitleMenuOpenChange: setSubtitleMenuOpened,
  };
}
