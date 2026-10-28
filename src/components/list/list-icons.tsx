import {
  Baby,
  Bookmark,
  BookOpen,
  Clapperboard,
  Clock,
  Drama,
  Eye,
  FaceGrinning,
  Film,
  Flame,
  Gamepad2,
  Ghost,
  Globe,
  Heart,
  type LucideIcon,
  Music2,
  Popcorn,
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
  { id: 'Clapperboard', Icon: Clapperboard, label: 'Cinema' },
  { id: 'Tv', Icon: Tv, label: 'Series' },
  { id: 'Popcorn', Icon: Popcorn, label: 'Movie night' },
  { id: 'Drama', Icon: Drama, label: 'Drama' },
  { id: 'Star', Icon: Star, label: 'Favourites' },
  { id: 'Heart', Icon: Heart, label: 'Loved' },
  { id: 'Sparkles', Icon: Sparkles, label: 'Hidden gems' },
  { id: 'Bookmark', Icon: Bookmark, label: 'Saved' },
  { id: 'Clock', Icon: Clock, label: 'Watch later' },
  { id: 'Eye', Icon: Eye, label: 'Watched' },
  { id: 'Trophy', Icon: Trophy, label: 'Award winners' },
  { id: 'Flame', Icon: Flame, label: 'Trending' },
  { id: 'Zap', Icon: Zap, label: 'Must watch' },
  { id: 'Globe', Icon: Globe, label: 'World cinema' },
  { id: 'Music2', Icon: Music2, label: 'Musicals' },
  { id: 'Laugh', Icon: FaceGrinning, label: 'Comedy' },
  { id: 'Ghost', Icon: Ghost, label: 'Horror' },
  { id: 'Swords', Icon: Swords, label: 'Action' },
  { id: 'Rocket', Icon: Rocket, label: 'Sci-fi' },
  { id: 'Baby', Icon: Baby, label: 'Family' },
  { id: 'BookOpen', Icon: BookOpen, label: 'Documentaries' },
  { id: 'Gamepad2', Icon: Gamepad2, label: 'Gaming' },
  { id: 'ThumbsUp', Icon: ThumbsUp, label: 'Recommended' },
];

const ICON_BY_ID = new Map(LIST_ICONS.map((icon) => [icon.id, icon]));

export const DEFAULT_LIST_ICON = 'Film';

const TILE_SIZES = {
  sm: { className: 'size-7 rounded-md', iconClassName: 'size-3.5' },
  md: { className: 'size-9 rounded-lg', iconClassName: 'size-[18px]' },
  lg: { className: 'size-12 rounded-xl', iconClassName: 'size-6' },
};

export function ListIconTile({
  iconId,
  size = 'md',
}: {
  iconId: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const found = ICON_BY_ID.get(iconId);
  const tile = TILE_SIZES[size];
  const Icon = found?.Icon;

  return (
    <span
      aria-hidden='true'
      className={cn(
        'inline-flex shrink-0 items-center justify-center bg-white/[0.04] text-zinc-300 ring-1 ring-inset ring-white/[0.08]',
        tile.className,
      )}
    >
      {Icon ? (
        <Icon className={tile.iconClassName} strokeWidth={1.75} />
      ) : (
        <span className='max-w-full truncate px-1 text-[11px] leading-none'>{iconId}</span>
      )}
    </span>
  );
}
