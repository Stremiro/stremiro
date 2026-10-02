import type { Episode } from '@/lib/api';
import type { PlayerRouteMediaType } from '@/lib/player-navigation';

/**
 * Everything a "Choose stream" surface needs to identify and present one
 * media target. One bundle threaded StreamSelector → controller → resolution
 * so the identity/presentation field set cannot drift between layers; hosts
 * pre-compute `title`/`overview` and hold the object in state (or a memo) so
 * identity stays stable for memoized consumers.
 */
export interface StreamSelectorTarget {
  type: PlayerRouteMediaType;
  id: string;
  /** Preferred stream lookup id (episode-specific when available); falls back to `id`. */
  streamId?: string;
  season?: number;
  episode?: number;
  absoluteSeason?: number;
  absoluteEpisode?: number;
  /** Raw title: it feeds the ranking key, so display fallbacks stay out. */
  title?: string;
  /** The target episode's own name — rendered under the title in the header. */
  episodeTitle?: string;
  overview?: string;
  poster?: string;
  backdrop?: string;
  logo?: string;
  /** Series episode list — lets a season-pack row open an episode picker. */
  episodes?: Episode[];
  /** Safe internal return path for the player's Back navigation. */
  from?: string;
  /**
   * The selector host's own origin — when `from` is a details page reached
   * from elsewhere, this carries that origin through so Back→details→Back
   * doesn't dead-end on the details route.
   */
  originFrom?: string;
}
