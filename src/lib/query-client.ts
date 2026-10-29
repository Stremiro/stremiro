import { QueryClient, replaceEqualDeep } from '@tanstack/react-query';
import {
  DETAILS_GC_TIME_MS,
  DETAILS_QUERY_KEY,
  WATCH_STATUSES_QUERY_KEY,
} from '@/lib/query-invalidation';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      networkMode: 'always', // Local IPC retries must run offline — Rust owns networking
      staleTime: 1000 * 60 * 5, // 5 min default — prevents redundant refetches
      gcTime: 1000 * 60 * 30, // 30 min in-memory cache retention
      refetchOnWindowFocus: false, // Desktop app — no tab switching noise
      refetchOnReconnect: true,
      retry: 1, // One retry on transient failures
    },
    mutations: { networkMode: 'always', gcTime: 0 },
  },
});
queryClient.setQueryDefaults(DETAILS_QUERY_KEY, { gcTime: DETAILS_GC_TIME_MS });
queryClient.setQueryDefaults(WATCH_STATUSES_QUERY_KEY, {
  // The default deep copy loses an own "__proto__" media ID through the prototype setter.
  structuralSharing: (previous, current) =>
    current !== null && typeof current === 'object' && Object.hasOwn(current, '__proto__')
      ? current
      : replaceEqualDeep(previous, current),
});
