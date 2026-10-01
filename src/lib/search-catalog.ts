import type { MediaItem, SearchCatalogPage } from '@/lib/api';
import { foldAsciiCase } from '@/lib/api-cache';

interface CatalogPageSummary {
  items: MediaItem[];
  lastPageAddsItems: boolean;
}

// Key the whole immutable pages array so middle-page refetches invalidate the summary.
const pageSummaries = new WeakMap<readonly SearchCatalogPage[], CatalogPageSummary>();
const itemKeys = new WeakMap<Pick<MediaItem, 'id' | 'type'>, string>();

export function searchCatalogKey(item: Pick<MediaItem, 'id' | 'type'>): string {
  let cached = itemKeys.get(item);
  if (!cached) {
    cached = `${foldAsciiCase(item.type.trim())}:${foldAsciiCase(item.id.trim())}`;
    itemKeys.set(item, cached);
  }
  return cached;
}

function getCatalogPageSummary(pages: readonly SearchCatalogPage[]): CatalogPageSummary {
  const cached = pageSummaries.get(pages);
  if (cached) return cached;

  const seen = new Set<string>();
  const items: MediaItem[] = [];
  let lastPageAddsItems = false;
  const lastIndex = pages.length - 1;
  pages.forEach((page, index) => {
    for (const item of page.items) {
      const key = searchCatalogKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
      if (index === lastIndex) lastPageAddsItems = true;
    }
  });

  const summary = { items, lastPageAddsItems };
  pageSummaries.set(pages, summary);
  return summary;
}

export function flattenCatalogPages(pages: readonly SearchCatalogPage[]): MediaItem[] {
  return getCatalogPageSummary(pages).items;
}

export function nextCatalogSkip(
  lastPage: SearchCatalogPage,
  allPages: SearchCatalogPage[],
  lastPageParam: number,
): number | undefined {
  const nextSkip = lastPage.nextSkip;
  if (typeof nextSkip !== 'number' || !Number.isFinite(nextSkip) || nextSkip <= lastPageParam) {
    return undefined;
  }

  // A page with no unseen titles ends pagination despite an advancing source cursor.
  if (allPages.length <= 1) {
    return lastPage.items.length > 0 ? nextSkip : undefined;
  }
  return getCatalogPageSummary(allPages).lastPageAddsItems ? nextSkip : undefined;
}
