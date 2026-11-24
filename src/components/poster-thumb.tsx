import { Film, Tv } from 'lucide-react';
import { RemoteImage } from '@/components/remote-image';
import { WatchProgressStrip } from '@/components/watch-progress-strip';
import { cn, isHttpUrl, isSeriesLikeMediaType } from '@/lib/utils';

const THUMB_SIZES = {
  sm: { box: 'h-10 w-7', icon: 'h-3 w-3' },
  md: { box: 'h-12 w-8', icon: 'h-3.5 w-3.5' },
  lg: { box: 'h-14 w-10', icon: 'h-4 w-4' },
} as const;

export function PosterThumb({
  poster,
  title = '',
  mediaType,
  progressPct,
  size = 'md',
  showFallback = true,
  className,
  imageClassName,
}: {
  poster?: string;
  title?: string;
  mediaType?: string;
  progressPct?: number;
  size?: keyof typeof THUMB_SIZES;
  showFallback?: boolean;
  className?: string;
  imageClassName?: string;
}) {
  const Icon = isSeriesLikeMediaType(mediaType) ? Tv : Film;
  const dims = THUMB_SIZES[size];

  return (
    <span
      className={cn(
        'relative flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-zinc-900/80 ring-1 ring-white/[0.06]',
        dims.box,
        className,
      )}
    >
      {showFallback &&
        (mediaType ? (
          <Icon className={cn('text-zinc-600', dims.icon)} />
        ) : (
          <span className='text-[8px] font-bold text-white/10'>N/A</span>
        ))}
      {isHttpUrl(poster) && (
        <RemoteImage
          src={poster}
          alt={title}
          className={cn('absolute inset-0 h-full w-full object-cover', imageClassName)}
          loading='lazy'
        />
      )}
      <WatchProgressStrip percent={progressPct ?? 0} className='h-0.5 bg-black/50' />
    </span>
  );
}
