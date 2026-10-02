import { useQuery } from '@tanstack/react-query';
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import type { PlayerOsdMessageIcon } from '@/components/player-osd-overlay';
import { type AddonSubtitle, api, getErrorMessage } from '@/lib/api';
import {
  addonSubtitleKey,
  buildTrackLabelMap,
  isExternalSubtitleTrack,
  type Track,
} from '@/lib/player-track-utils';
import { addonSubtitlesQueryKey } from '@/lib/query-invalidation';
import { nonBlank } from '@/lib/utils';

// Stable fallback so `?? []` never changes memo identity per render.
const EMPTY_ADDON_SUBTITLES: AddonSubtitle[] = [];

/** Addon subtitle URLs are untrusted input fed to a privileged mpv command. */
function isSafeAddonSubtitleUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

interface UsePlayerAddonSubtitlesOptions {
  activeStreamUrl?: string;
  announce: (text: string, icon?: PlayerOsdMessageIcon) => void;
  effectiveResolveMediaType: string;
  id?: string;
  isSeriesLike: boolean;
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
  isSeriesLike,
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

  const subtitleLookup = useMemo(() => {
    const base = streamLookupId || id;
    if (!base) return { lookupId: undefined, season: undefined, episode: undefined };
    // Only a trailing :season:episode means the id is already episode-scoped;
    // namespaced base ids (kitsu:48316) still need coordinates appended.
    if (!isSeriesLike || /:\d+:\d+$/.test(base))
      return { lookupId: base, season: undefined, episode: undefined };
    return {
      lookupId: base,
      season: resolvedStreamSeason,
      episode: resolvedStreamEpisode,
    };
  }, [streamLookupId, id, isSeriesLike, resolvedStreamSeason, resolvedStreamEpisode]);

  // Addon subtitles fetch lazily on first menu open. Addon-sub identity is
  // bound to the loaded file's track-list — external tracks die with the
  // stream, so the active/loading keys reset with it.
  useEffect(() => {
    subtitleSessionEpochRef.current += 1;
    setPickedAddonSubtitleId(null);
    setAddonSubtitleLoadingId(null);
    return () => {
      subtitleSessionEpochRef.current += 1;
    };
  }, [activeStreamUrl]);

  // Normalized once so the query key matches the trimmed values the API
  // layer sends — untrimmed keys would split one request into two entries.
  const lookupMediaType = effectiveResolveMediaType.trim();
  const lookupMediaId = subtitleLookup.lookupId?.trim();
  const subtitlesEnabled = subtitleMenuOpened && lookupMediaType !== '' && !!lookupMediaId;

  const subtitlesQuery = useQuery({
    queryKey: addonSubtitlesQueryKey(
      lookupMediaType || undefined,
      lookupMediaId,
      subtitleLookup.season,
      subtitleLookup.episode,
    ),
    queryFn: () => {
      if (!lookupMediaType || !lookupMediaId) throw new Error('Missing media identity');
      return api.getAddonSubtitles(
        lookupMediaType,
        lookupMediaId,
        subtitleLookup.season,
        subtitleLookup.episode,
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
  // Distinguishes "lookup ran and returned nothing" from "never asked" —
  // the empty-state hint must not render before the first request.
  const addonSubtitlesQueried = subtitlesEnabled;

  const handleSelectAddonSubtitle = useCallback(
    async (subtitle: AddonSubtitle) => {
      if (addonSubtitleLoadingId || !mountedRef.current) return;
      if (!isSafeAddonSubtitleUrl(subtitle.url)) {
        toast.error('Invalid subtitle URL');
        return;
      }
      const subtitleKey = addonSubtitleKey(subtitle);
      const epoch = subtitleSessionEpochRef.current;
      setAddonSubtitleLoadingId(subtitleKey);
      try {
        // The track controller owns the mpv side: URL reuse via
        // external-filename, the single-switch gate, fetch polling, and
        // preference persistence that keeps auto-apply from reverting.
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

  // Stable props for the memoized selectors — the controls overlay re-renders
  // on every time update, so inline closures here would defeat the memo.
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

  // Follow the popover rather than latching open: a closed menu stops the
  // addon query's refetch eligibility — its cached data still paints on the
  // next open, so reopening stays instant.
  const handleSubtitleMenuOpenChange = useCallback((open: boolean) => {
    setSubtitleMenuOpened(open);
  }, []);

  const handleAddonSubtitleSelect = useCallback(
    (subtitle: AddonSubtitle) => {
      void handleSelectAddonSubtitle(subtitle);
    },
    [handleSelectAddonSubtitle],
  );

  // The addon checkmark is derived from mpv truth: only one sid can be
  // selected, so the row follows the selected external track whether it got
  // there from this menu, a restored preference, or `cycle sub`. The explicit
  // pick only disambiguates rows that resolve to the same external track.
  const activeAddonSubtitleId = useMemo(() => {
    const selectedExternal = subTracks.find(
      (track) => track.type === 'sub' && track.selected && track.external,
    );
    if (!selectedExternal) return null;
    const matches = addonSubtitles.filter((subtitle) =>
      isExternalSubtitleTrack(selectedExternal, subtitle),
    );
    if (matches.length === 0) return null;
    return matches.some((subtitle) => addonSubtitleKey(subtitle) === pickedAddonSubtitleId)
      ? pickedAddonSubtitleId
      : addonSubtitleKey(matches[0]);
  }, [addonSubtitles, pickedAddonSubtitleId, subTracks]);

  return {
    activeAddonSubtitleId,
    addonSubtitleLoadingId,
    addonSubtitles,
    addonSubtitlesError,
    addonSubtitlesLoading,
    addonSubtitlesQueried,
    handleAddonSubtitleSelect,
    handleSubTrackSelect,
    handleSubtitleMenuOpenChange,
  };
}
