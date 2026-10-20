import { useCallback, useEffect, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router';

import {
  readSearchFacets,
  rememberSearchParams,
  type SearchFeed,
  type SearchMediaType,
} from '@/lib/search-page-state';

// The URL owns committed queries and facets; only typing stays local.
export function useSearchPageState() {
  const { pathname } = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    query: urlQuery,
    type: activeType,
    feed: activeFeed,
    genre: activeGenre,
  } = readSearchFacets(searchParams);

  const [input, setInput] = useState({ urlQuery, query: urlQuery });
  const [reflectedQuery, setReflectedQuery] = useState<string | null>(null);
  const [isComposing, setIsComposing] = useState(false);
  const { query } = input;

  // Navigation is already committed input; don't debounce it or render the old query.
  if (input.urlQuery !== urlQuery) {
    const isReflection = reflectedQuery === urlQuery;
    const nextQuery = isReflection || query.trim() === urlQuery ? query : urlQuery;
    setInput({ urlQuery, query: nextQuery });
    setReflectedQuery(null);
    if (!isReflection) setIsComposing(false);
  }

  const setQuery = useCallback(
    (nextQuery: string) => setInput({ urlQuery, query: nextQuery }),
    [urlQuery],
  );
  const trimmedQuery = query.trim();
  const trimmedDebouncedQuery = isComposing || trimmedQuery ? urlQuery.trim() : '';

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
    if (isComposing || window.location.pathname !== pathname) return;
    setReflectedQuery(trimmedQuery);
    updateSearchParams((params) => {
      if (trimmedQuery) params.set('q', trimmedQuery);
      else params.delete('q');
    });
  }, [isComposing, pathname, trimmedQuery, updateSearchParams]);

  // Remember drafts immediately; commit typing without adding history.
  useEffect(() => {
    const rememberedParams = new URLSearchParams(searchParams);
    if (query) rememberedParams.set('q', query);
    else rememberedParams.delete('q');
    rememberSearchParams(rememberedParams);

    if (isComposing || trimmedQuery === urlQuery) return;
    if (!trimmedQuery) {
      flushQuery();
      return;
    }
    const timer = window.setTimeout(flushQuery, 180);
    return () => window.clearTimeout(timer);
  }, [flushQuery, isComposing, query, searchParams, trimmedQuery, urlQuery]);

  const handleTypeChange = useCallback(
    (nextType: SearchMediaType, clearIncompatibleGenre = false) => {
      if (!isComposing) setReflectedQuery(trimmedQuery);
      updateSearchParams((params) => {
        if (!isComposing) {
          if (trimmedQuery) params.set('q', trimmedQuery);
          else params.delete('q');
        }
        if (nextType === 'all') params.delete('type');
        else params.set('type', nextType);
        if (clearIncompatibleGenre) params.delete('genre');
      });
    },
    [isComposing, trimmedQuery, updateSearchParams],
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

  const hasActiveFilters =
    activeType !== 'all' || (!trimmedDebouncedQuery && activeFeed !== 'popular') || !!activeGenre;

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
    flushQuery,
    handleFeedChange,
    handleGenreChange,
    handleTypeChange,
    hasActiveFilters,
    isComposing,
    query,
    resetFilters,
    setQuery,
    setIsComposing,
    trimmedDebouncedQuery,
    trimmedQuery,
  };
}
