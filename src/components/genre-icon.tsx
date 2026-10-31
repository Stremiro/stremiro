import {
  Activity,
  Drama,
  Fingerprint,
  Gamepad2,
  Ghost,
  Heart,
  Landmark,
  Leaf,
  Mic,
  Mountain,
  Music2,
  Orbit,
  ScanEye,
  Shapes,
  Smile,
  Sparkles,
  Swords,
  Telescope,
  Trophy,
  Tv,
  Users,
  WandSparkles,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const GENRE_ICONS: Record<string, readonly [LucideIcon, string]> = {
  action: [Zap, 'text-amber-400/90'],
  adventure: [Leaf, 'text-emerald-400/95'],
  animation: [Sparkles, 'text-sky-300/90'],
  comedy: [Smile, 'text-amber-300/90'],
  crime: [Fingerprint, 'text-stone-300/90'],
  documentary: [Telescope, 'text-sky-300/90'],
  drama: [Drama, 'text-rose-300/90'],
  family: [Users, 'text-teal-300/90'],
  fantasy: [WandSparkles, 'text-violet-300/90'],
  'film-noir': [ScanEye, 'text-slate-300/90'],
  'game-show': [Gamepad2, 'text-cyan-300/90'],
  history: [Landmark, 'text-amber-300/90'],
  horror: [Ghost, 'text-violet-300/90'],
  music: [Music2, 'text-fuchsia-300/90'],
  musical: [Music2, 'text-fuchsia-300/90'],
  mystery: [ScanEye, 'text-indigo-300/90'],
  'reality-tv': [Tv, 'text-sky-300/90'],
  romance: [Heart, 'text-rose-300/90'],
  'sci-fi': [Orbit, 'text-blue-300/90'],
  'science fiction': [Orbit, 'text-blue-300/90'],
  sport: [Trophy, 'text-lime-300/90'],
  'talk-show': [Mic, 'text-teal-300/90'],
  thriller: [Activity, 'text-orange-300/90'],
  war: [Swords, 'text-stone-300/90'],
  western: [Mountain, 'text-amber-300/90'],
};

export function GenreIcon({ genre, className }: { genre?: string; className?: string }) {
  const key = genre?.trim().toLowerCase() ?? '';
  const entry = Object.hasOwn(GENRE_ICONS, key) ? GENRE_ICONS[key] : undefined;
  const [Icon, tint] = entry ?? [Shapes, 'text-zinc-400'];
  return (
    <Icon
      aria-hidden='true'
      strokeWidth={1.75}
      className={cn('size-3.5 shrink-0', tint, className)}
    />
  );
}
