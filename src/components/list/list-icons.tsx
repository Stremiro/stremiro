import {
  Baby,
  Bookmark,
  BookOpen,
  Clapperboard,
  Clock,
  Eye,
  Film,
  Flame,
  Gamepad2,
  Ghost,
  Globe,
  Heart,
  Laugh,
  type LucideIcon,
  Music2,
  Rocket,
  Sparkles,
  Star,
  Swords,
  ThumbsUp,
  Trophy,
  Tv,
  Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface ListIconDef {
  id: string;
  Icon: LucideIcon;
  label: string;
}

export const LIST_ICONS: ListIconDef[] = [
  { id: 'Film', Icon: Film, label: 'Movies' },
  { id: 'Tv', Icon: Tv, label: 'Series' },
  { id: 'Star', Icon: Star, label: 'Favourites' },
  { id: 'Heart', Icon: Heart, label: 'Loved' },
  { id: 'Sparkles', Icon: Sparkles, label: 'Highlights' },
  { id: 'Clapperboard', Icon: Clapperboard, label: 'Cinema' },
  { id: 'Bookmark', Icon: Bookmark, label: 'Saved' },
  { id: 'Zap', Icon: Zap, label: 'Must Watch' },
  { id: 'Clock', Icon: Clock, label: 'Watch Later' },
  { id: 'Eye', Icon: Eye, label: 'Watched' },
  { id: 'ThumbsUp', Icon: ThumbsUp, label: 'Liked' },
  { id: 'Trophy', Icon: Trophy, label: 'Best Of' },
  { id: 'Flame', Icon: Flame, label: 'Hot' },
  { id: 'Globe', Icon: Globe, label: 'World' },
  { id: 'Music2', Icon: Music2, label: 'Musical' },
  { id: 'Laugh', Icon: Laugh, label: 'Comedy' },
  { id: 'Ghost', Icon: Ghost, label: 'Horror' },
  { id: 'Swords', Icon: Swords, label: 'Action' },
  { id: 'Rocket', Icon: Rocket, label: 'Sci-Fi' },
  { id: 'Baby', Icon: Baby, label: 'Kids' },
  { id: 'BookOpen', Icon: BookOpen, label: 'Docs' },
  { id: 'Gamepad2', Icon: Gamepad2, label: 'Gaming' },
];

export const DEFAULT_LIST_ICON = 'Film';

interface ListIconProps {
  iconId: string;
  /** Extra Tailwind classes applied to the icon / fallback span */
  className?: string;
  /** Pixel size passed to the Lucide icon (default 16) */
  size?: number;
}

/**
 * Renders a list icon.
 * - If `iconId` matches a known Lucide icon name → renders the SVG icon.
 * - Otherwise falls back to rendering the raw string (legacy emoji support).
 */
export function ListIcon({ iconId, className, size = 16 }: ListIconProps) {
  const found = LIST_ICONS.find((i) => i.id === iconId);

  if (!found) {
    // Legacy emoji / unknown identifier — render as text
    return (
      <span
        className={cn('leading-none select-none', className)}
        style={{ fontSize: size }}
        aria-hidden='true'
      >
        {iconId}
      </span>
    );
  }

  const { Icon } = found;
  return (
    <Icon width={size} height={size} className={cn('shrink-0', className)} aria-hidden='true' />
  );
}
