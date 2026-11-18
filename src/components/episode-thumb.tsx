import type { ReactNode } from 'react';
import { RemoteImage } from '@/components/remote-image';
import { WatchProgressStrip } from '@/components/watch-progress-strip';
import { cn } from '@/lib/utils';

/** Shared episode thumbnail: `E#` fallback under artwork, spoiler blur, watched-progress strip. */
export function EpisodeThumb({
  episode,
  src,
  fallbackSrc,
  fallbackLabel,
  fadeIn,
  children,
  isSpoiler,
  progressPercent,
  className,
  fallbackClassName,
  imageClassName,
  stripClassName,
}: {
  episode: number;
  src?: string;
  fallbackSrc?: string;
  fallbackLabel?: ReactNode;
  fadeIn?: boolean;
  children?: ReactNode;
  isSpoiler?: boolean;
  progressPercent: number;
  className?: string;
  fallbackClassName?: string;
  imageClassName?: string;
  stripClassName?: string;
}) {
  const primarySrc = src || fallbackSrc;
  const secondarySrc = src && fallbackSrc && src !== fallbackSrc ? fallbackSrc : undefined;
  return (
    <div className={cn('relative shrink-0 overflow-hidden bg-zinc-900', className)}>
      <div className={cn('absolute inset-0 flex items-center justify-center', fallbackClassName)}>
        {fallbackLabel ?? `E${episode}`}
      </div>
      {primarySrc && (
        <RemoteImage
          src={primarySrc}
          fallbackSrc={secondarySrc}
          fadeIn={fadeIn}
          loading='lazy'
          className={cn(
            'relative h-full w-full object-cover',
            isSpoiler && 'scale-110 blur-md',
            imageClassName,
          )}
          alt=''
        />
      )}
      {children}
      <WatchProgressStrip percent={progressPercent} className={stripClassName} />
    </div>
  );
}
