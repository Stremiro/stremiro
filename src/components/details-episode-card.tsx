import { memo, type Ref } from 'react';
import { Check, Play } from 'lucide-react';
import type { Episode } from '@/lib/api';
import { RemoteImage } from '@/components/remote-image';
import { WatchProgressStrip } from '@/components/watch-progress-strip';
import { useFailedSrc } from '@/hooks/use-failed-src';
import { cn, formatAirDate, formatSeasonEpisode, getEpisodeTitle } from '@/lib/utils';

interface EpisodeCardProps {
  episode: Episode;
  isResume: boolean;
  isSpoiler: boolean;
  isWatched: boolean;
  isWatchedPending: boolean;
  progressPercent: number;
  resumeRef?: Ref<HTMLButtonElement>;
  onPlay: (episode: Episode) => void;
  onToggleWatched?: (episode: Episode) => void;
}

function EpisodeCardInner({
  episode,
  isResume,
  isSpoiler,
  isWatched,
  isWatchedPending,
  progressPercent,
  resumeRef,
  onPlay,
  onToggleWatched,
}: EpisodeCardProps) {
  const [thumbnail, onThumbnailError] = useFailedSrc(episode.thumbnail);
  const title = getEpisodeTitle(isSpoiler ? undefined : episode.title, episode.episode);
  const airDate = formatAirDate(episode.releaseDate);

  return (
    <div className='relative'>
      <button
        type='button'
        ref={resumeRef}
        onClick={() => onPlay(episode)}
        title={title}
        className={cn(
          'group/episode relative block aspect-video w-full overflow-hidden rounded-lg border bg-zinc-900 text-left transition-colors duration-200',
          'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/50',
          isResume ? 'border-white/15' : 'border-white/[0.08]',
        )}
      >
        {thumbnail ? (
          <RemoteImage
            src={thumbnail}
            alt=''
            className={cn(
              'absolute inset-0 h-full w-full object-cover transition-[scale,filter] duration-500',
              isSpoiler
                ? 'scale-110 blur-md'
                : 'group-hover/episode:scale-[1.02] group-hover/episode:brightness-110',
            )}
            loading='lazy'
            onError={onThumbnailError}
          />
        ) : (
          <div className='absolute inset-0 flex items-center justify-center bg-zinc-900 text-xl font-semibold text-white/25 transition-colors duration-200 group-hover/episode:text-white/35'>
            {episode.episode}
          </div>
        )}

        <div className='pointer-events-none absolute inset-0 bg-linear-to-t from-black/90 via-black/25 to-black/5' />

        <div className='absolute left-2 top-2 flex items-center gap-1.5'>
          <span className='flex h-5 items-center rounded-md border border-white/10 bg-black/60 px-1.5 text-[10px] font-semibold leading-none tabular-nums text-white/90'>
            E{episode.episode}
          </span>
          {isResume && (
            <span className='flex h-5 items-center rounded-md bg-white px-1.5 text-[11px] font-medium leading-none text-black'>
              Resume
            </span>
          )}
        </div>

        <div className='pointer-events-none absolute inset-0 z-10 flex items-center justify-center opacity-0 transition-opacity duration-200 group-hover/episode:opacity-100 group-focus-visible/episode:opacity-100'>
          <div className='flex h-9 w-9 items-center justify-center rounded-lg bg-black/65'>
            <Play className='ml-0.5 h-4 w-4 fill-white text-white' />
          </div>
        </div>

        <div className='pointer-events-none absolute inset-x-0 bottom-0 z-10 p-3'>
          <h4 className='line-clamp-2 text-sm font-medium leading-snug text-white drop-shadow-md'>
            {title}
          </h4>
          {airDate && <p className='mt-0.5 truncate text-[11px] text-white/65'>{airDate}</p>}
        </div>

        <WatchProgressStrip percent={progressPercent} className='z-20' />
      </button>

      {onToggleWatched && (
        <button
          type='button'
          aria-pressed={isWatched}
          aria-disabled={isWatchedPending || undefined}
          aria-label={`Mark ${formatSeasonEpisode(episode.season, episode.episode) || `episode ${episode.episode}`} as ${isWatched ? 'unwatched' : 'watched'}`}
          title={isWatched ? 'Mark as unwatched' : 'Mark as watched'}
          onClick={() => onToggleWatched(episode)}
          className='group/watch absolute right-1 top-1 z-30 flex h-11 w-11 items-center justify-center rounded-lg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/50 aria-disabled:cursor-wait'
        >
          <span
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-md border transition-colors duration-150',
              isWatched
                ? 'border-white bg-white text-black'
                : 'border-white/15 bg-black/65 text-white/65 group-hover/watch:border-white/30 group-hover/watch:text-white group-focus-visible/watch:text-white',
            )}
          >
            <Check className='h-3.5 w-3.5' strokeWidth={2.5} />
          </span>
        </button>
      )}
    </div>
  );
}

export const EpisodeCard = memo(EpisodeCardInner);
