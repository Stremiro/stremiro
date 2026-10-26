export const routeChunks = {
  search: () => import('@/pages/search'),
  details: () => import('@/pages/details'),
  settings: () => import('@/pages/settings/index'),
  profile: () => import('@/pages/profile'),
  calendar: () => import('@/pages/calendar'),
  player: () => import('@/pages/player'),
};

/** Kick the player chunk fetch early so launch is an instant Suspense hit. */
export function warmPlayerChunk() {
  void routeChunks.player().catch(() => undefined);
}
