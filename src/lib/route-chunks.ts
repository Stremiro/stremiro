export const routeChunks = {
  search: () => import('@/pages/search'),
  details: () => import('@/pages/details'),
  settings: () => import('@/pages/settings/index'),
  profile: () => import('@/pages/profile'),
  calendar: () => import('@/pages/calendar'),
  player: () => import('@/pages/player'),
};
