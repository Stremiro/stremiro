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

interface ListIconDef {
  id: string;
  Icon: LucideIcon;
  label: string;
  hue: keyof typeof ICON_HUES;
}

const ICON_HUES = {
  rose: '251 113 133',
  amber: '251 191 36',
  emerald: '52 211 153',
  sky: '56 189 248',
  violet: '167 139 250',
  fuchsia: '232 121 249',
  teal: '45 212 191',
  orange: '251 146 60',
  indigo: '129 140 248',
  lime: '163 230 53',
};

export const LIST_ICONS: ListIconDef[] = [
  { id: 'Film', Icon: Film, label: 'Movies', hue: 'sky' },
  { id: 'Clapperboard', Icon: Clapperboard, label: 'Cinema', hue: 'violet' },
  { id: 'Tv', Icon: Tv, label: 'Series', hue: 'indigo' },
  { id: 'Popcorn', Icon: Popcorn, label: 'Movie night', hue: 'amber' },
  { id: 'Drama', Icon: Drama, label: 'Drama', hue: 'rose' },
  { id: 'Star', Icon: Star, label: 'Favourites', hue: 'amber' },
  { id: 'Heart', Icon: Heart, label: 'Loved', hue: 'rose' },
  { id: 'Sparkles', Icon: Sparkles, label: 'Hidden gems', hue: 'fuchsia' },
  { id: 'Bookmark', Icon: Bookmark, label: 'Saved', hue: 'emerald' },
  { id: 'Clock', Icon: Clock, label: 'Watch later', hue: 'teal' },
  { id: 'Eye', Icon: Eye, label: 'Watched', hue: 'sky' },
  { id: 'Trophy', Icon: Trophy, label: 'Award winners', hue: 'amber' },
  { id: 'Flame', Icon: Flame, label: 'Trending', hue: 'orange' },
  { id: 'Zap', Icon: Zap, label: 'Must watch', hue: 'lime' },
  { id: 'Globe', Icon: Globe, label: 'World cinema', hue: 'teal' },
  { id: 'Music2', Icon: Music2, label: 'Musicals', hue: 'fuchsia' },
  { id: 'Laugh', Icon: FaceGrinning, label: 'Comedy', hue: 'amber' },
  { id: 'Ghost', Icon: Ghost, label: 'Horror', hue: 'violet' },
  { id: 'Swords', Icon: Swords, label: 'Action', hue: 'orange' },
  { id: 'Rocket', Icon: Rocket, label: 'Sci-fi', hue: 'indigo' },
  { id: 'Baby', Icon: Baby, label: 'Family', hue: 'lime' },
  { id: 'BookOpen', Icon: BookOpen, label: 'Documentaries', hue: 'emerald' },
  { id: 'Gamepad2', Icon: Gamepad2, label: 'Gaming', hue: 'violet' },
  { id: 'ThumbsUp', Icon: ThumbsUp, label: 'Recommended', hue: 'sky' },
];

const ICON_BY_ID = new Map(LIST_ICONS.map((icon) => [icon.id, icon]));

export const DEFAULT_LIST_ICON = 'Film';

const TILE_SIZES = {
  sm: { className: 'h-7 w-7 rounded-md', iconSize: 15, strokeWidth: 2.25 },
  md: { className: 'h-9 w-9 rounded-lg', iconSize: 19, strokeWidth: 2 },
  lg: { className: 'h-14 w-14 rounded-xl', iconSize: 28, strokeWidth: 1.8 },
};

export function ListIconTile({
  iconId,
  size = 'md',
}: {
  iconId: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const found = ICON_BY_ID.get(iconId);
  const hue = found ? ICON_HUES[found.hue] : '161 161 170';
  const tile = TILE_SIZES[size];
  const Icon = found?.Icon;

  return (
    <span
      aria-hidden='true'
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden ring-1 ring-inset ring-white/10 ${tile.className}`}
      style={{
        color: `rgb(${hue})`,
        background: `linear-gradient(145deg, rgb(${hue} / 0.18), rgb(${hue} / 0.04))`,
      }}
    >
      {Icon ? (
        <Icon size={tile.iconSize} strokeWidth={tile.strokeWidth} />
      ) : (
        <span className='max-w-full truncate px-1 leading-none' style={{ fontSize: tile.iconSize }}>
          {iconId}
        </span>
      )}
    </span>
  );
}
