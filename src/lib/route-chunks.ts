export const routeChunks = {
  search: () => import('@/pages/search'),
  details: () => import('@/pages/details'),
  settings: () => import('@/pages/settings/index'),
  profile: () => import('@/pages/profile'),
  calendar: () => import('@/pages/calendar'),
  player: () => import('@/pages/player'),
};

export function warmRouteChunks(): void {
  for (const load of Object.values(routeChunks)) void load().catch(() => undefined);
}
