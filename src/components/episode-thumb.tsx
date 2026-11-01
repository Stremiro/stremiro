import { RemoteImage } from '@/components/remote-image';
import { WatchProgressStrip } from '@/components/watch-progress-strip';
import { cn } from '@/lib/utils';

/** Shared episode thumbnail: `E#` fallback under artwork, spoiler blur, watched-progress strip. */
export function EpisodeThumb({
  episode,
  src,
  isSpoiler,
  progressPercent,
  className,
  fallbackClassName,
  imageClassName,
  stripClassName,
}: {
  episode: number;
  src?: string;
  isSpoiler?: boolean;
  progressPercent: number;
  className?: string;
  fallbackClassName?: string;
  imageClassName?: string;
  stripClassName?: string;
}) {
  return (
    <div className={cn('relative shrink-0 overflow-hidden bg-zinc-900', className)}>
      <div className={cn('absolute inset-0 flex items-center justify-center', fallbackClassName)}>
        E{episode}
      </div>
      {src && (
        <RemoteImage
          src={src}
          loading='lazy'
          className={cn(
            'relative h-full w-full object-cover',
            isSpoiler && 'scale-110 blur-md',
            imageClassName,
          )}
          alt=''
        />
      )}
      <WatchProgressStrip percent={progressPercent} className={stripClassName} />
    </div>
  );
}
