import type { Episode } from '@/lib/api';
import type { PlayerRouteMediaType } from '@/lib/player-navigation';

/** One media-target bundle threaded StreamSelector → controller → resolution; hosts hold it in state/memo for stable identity. */
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
  /** The selector host's own origin — carried through so Back→details→Back doesn't dead-end on the details route. */
  originFrom?: string;
}
