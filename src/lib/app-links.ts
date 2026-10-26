import { toast } from 'sonner';
import { api, type AppLink } from '@/lib/api';
import { navigateApp } from '@/lib/navigation';
import { buildDetailsRoute, navigateToDetails } from '@/lib/player-navigation';

const APP_LINK_SCHEME = 'stremiro://';

export function isAppLinkText(text: string): boolean {
  return text.trim().slice(0, APP_LINK_SCHEME.length).toLowerCase() === APP_LINK_SCHEME;
}

/** Mirrors the in-app details route, which Rust's link parser maps back onto. */
export function buildTitleShareLink(mediaType: string, mediaId: string): string {
  return `${APP_LINK_SCHEME}${buildDetailsRoute(mediaType, mediaId).slice(1)}`;
}

// Router state, not the query string: lastVisited persists the URL and addon links may carry keys.
export function openAppLink(link: AppLink): void {
  if (link.kind === 'title') {
    navigateToDetails(link.mediaType, link.mediaId);
  } else {
    navigateApp('/settings?section=addons', { state: { addonInstallUrl: link.url } });
  }
}

export async function openAppLinkText(text: string): Promise<void> {
  const link = await api.resolveAppLink(text).catch(() => null);
  if (link) {
    openAppLink(link);
  } else {
    toast.error('Could not open this Stremiro link');
  }
}
