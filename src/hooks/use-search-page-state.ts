import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router';

import { useDebounce } from '@/hooks/use-debounce';
import {
  readSearchFacets,
  rememberSearchParams,
  type SearchFeed,
  type SearchMediaType,
} from '@/lib/search-page-state';

// Search-page state: debounced query text plus browse facets. The URL carries
// `?q=`, `?type=`, `?feed=`, `?genre=`; the backend defaults anything omitted.
export function useSearchPageState() {
  const { pathname } = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlQuery = searchParams.get('q') || '';
  const { type: activeType, feed: activeFeed, genre: activeGenre } = readSearchFacets(searchParams);

  const [query, setQuery] = useState(urlQuery);
  const debouncedInput = useDebounce(query, 250);
  const debouncedQuery = query.trim() ? debouncedInput : '';

  const trimmedQuery = query.trim();
  const trimmedDebouncedQuery = debouncedQuery.trim();

  // Adopt the URL only when navigation changed it — keying on `query` too would
  // wipe keystrokes. The trim-equality guard keeps an in-flight trailing space.
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
  const flushQuery = useCallback(() => {
    if (window.location.pathname !== pathname) return;
    updateSearchParams((params) => {
      if (trimmedQuery) params.set('q', trimmedQuery);
      else params.delete('q');
    });
  }, [pathname, trimmedQuery, updateSearchParams]);

  // Remember drafts immediately; reflect settled queries without adding history.
  // Cloning preserves unknown keys. Skip reflection while the
  // debounce still lags raw input or a navigation-side `q` change is pending.
  const lastReflectedUrlQueryRef = useRef(urlQuery);
  useEffect(() => {
    if (urlQuery !== lastReflectedUrlQueryRef.current) {
      lastReflectedUrlQueryRef.current = urlQuery;
      rememberSearchParams(searchParams);
      return;
    }

    const rememberedParams = new URLSearchParams(searchParams);
    if (query) rememberedParams.set('q', query);
    else rememberedParams.delete('q');
    rememberSearchParams(rememberedParams);

    if (trimmedQuery !== trimmedDebouncedQuery) {
      return;
    }

    flushQuery();
  }, [flushQuery, query, searchParams, trimmedDebouncedQuery, trimmedQuery, urlQuery]);

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

  const handleGenreChange = useCallback(
    (genre: string) => {
      updateSearchParams((params) => params.set('genre', genre));
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
    flushQuery,
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
