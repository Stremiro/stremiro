import { resolvePlayerLaunch } from '@/lib/player-navigation';
import { usePlayerSession } from '@/lib/player-session';

export function usePlayerRouteState() {
  const { session } = usePlayerSession();
  return resolvePlayerLaunch(session ?? {});
}
