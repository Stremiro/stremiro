import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';

import { useDebounce } from '@/hooks/use-debounce';
import {
  resolveSearchUrlFeed,
  resolveSearchUrlGenre,
  resolveSearchUrlType,
  sameSearchGenre,
  type SearchFeed,
  type SearchMediaType,
} from '@/lib/search-page-state';

// Minimal search-page state: query text (debounced for transport) plus the
// browse facets. The URL carries `?q=`, `?type=`, `?feed=`, and `?genre=` so a
// filtered browse is deterministic and restorable; the backend applies safe
// defaults for everything omitted.
export function useSearchPageState() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlQuery = searchParams.get('q') || '';
  const activeType = resolveSearchUrlType(searchParams.get('type'));
  const activeFeed = resolveSearchUrlFeed(searchParams.get('feed'));
  const activeGenre = resolveSearchUrlGenre(searchParams.get('genre'));

  const [query, setQuery] = useState(urlQuery);
  const debouncedInput = useDebounce(query, 250);
  const debouncedQuery = query.trim() ? debouncedInput : '';

  const trimmedQuery = query.trim();
  const trimmedDebouncedQuery = debouncedQuery.trim();

  // Adopt the URL only when navigation itself changed it (back/forward, deep
  // links) — keying this on `query` too would wipe every keystroke with the
  // stale URL value. The trim-equality guard keeps an in-flight trailing space.
  useEffect(() => {
    setQuery((current) => (current.trim() === urlQuery ? current : urlQuery));
  }, [urlQuery]);

  // Facets are URL-owned; only typing needs a local draft and debounce.
  const updateSearchParams = useCallback(
    (update: (params: URLSearchParams) => void) => {
      const nextParams = new URLSearchParams(searchParams);
      update(nextParams);
      if (searchParams.toString() !== nextParams.toString()) {
        setSearchParams(nextParams, { replace: true });
      }
    },
    [searchParams, setSearchParams],
  );

  // Reflect state back into the URL without growing history entries. Cloning
  // the current params preserves unknown/future keys. The settle guard skips
  // reflection while the debounce lags behind raw input, so typing or a fresh
  // navigation is never overwritten by the stale debounced value.
  const lastReflectedUrlQueryRef = useRef(urlQuery);
  useEffect(() => {
    // A `q` change since the last run came from navigation itself, so the
    // still-stale debounced value must not be written back over it.
    if (urlQuery !== lastReflectedUrlQueryRef.current) {
      lastReflectedUrlQueryRef.current = urlQuery;
      return;
    }

    if (trimmedQuery !== trimmedDebouncedQuery) {
      return;
    }

    updateSearchParams((params) => {
      if (trimmedDebouncedQuery) {
        params.set('q', trimmedDebouncedQuery);
      } else {
        params.delete('q');
      }
    });
  }, [updateSearchParams, trimmedDebouncedQuery, trimmedQuery, urlQuery]);

  const handleTypeChange = useCallback(
    (nextType: SearchMediaType, clearIncompatibleGenre = false) => {
      updateSearchParams((params) => {
        if (nextType === 'all') params.delete('type');
        else params.set('type', nextType);
        if (clearIncompatibleGenre) params.delete('genre');
      });
    },
    [updateSearchParams],
  );

  const handleFeedChange = useCallback(
    (nextFeed: SearchFeed) => {
      updateSearchParams((params) => {
        if (nextFeed === 'popular') params.delete('feed');
        else params.set('feed', nextFeed);
      });
    },
    [updateSearchParams],
  );

  // Re-selecting the active genre clears it; compare exactly as the menu does.
  const handleGenreChange = useCallback(
    (genre: string) => {
      updateSearchParams((params) => {
        const current = resolveSearchUrlGenre(params.get('genre'));
        if (sameSearchGenre(current, genre)) {
          params.delete('genre');
        } else {
          params.set('genre', genre);
        }
      });
    },
    [updateSearchParams],
  );

  const clearGenre = useCallback(() => {
    updateSearchParams((params) => params.delete('genre'));
  }, [updateSearchParams]);

  const hasActiveFilters = activeType !== 'all' || activeFeed !== 'popular' || !!activeGenre;

  // Hard reset back to the default browse: all types, trending, no genre.
  const resetFilters = useCallback(() => {
    updateSearchParams((params) => {
      params.delete('type');
      params.delete('feed');
      params.delete('genre');
    });
  }, [updateSearchParams]);

  return {
    activeFeed,
    activeGenre,
    activeType,
    clearGenre,
    debouncedQuery,
    handleFeedChange,
    handleGenreChange,
    handleTypeChange,
    hasActiveFilters,
    query,
    resetFilters,
    setQuery,
    trimmedDebouncedQuery,
  };
}
