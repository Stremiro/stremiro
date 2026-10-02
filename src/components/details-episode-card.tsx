import { memo, useState, type Ref } from 'react';
import { Check, Play } from 'lucide-react';
import type { Episode } from '@/lib/api';
import { RemoteImage } from '@/components/remote-image';
import { WatchProgressStrip } from '@/components/watch-progress-strip';
import { cn, formatAirDate, formatSeasonEpisode, getEpisodeTitle } from '@/lib/utils';

interface EpisodeCardProps {
  episode: Episode;
  isResume: boolean;
  isSpoiler: boolean;
  isWatched: boolean;
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
  progressPercent,
  resumeRef,
  onPlay,
  onToggleWatched,
}: EpisodeCardProps) {
  // Latch only the URL that failed — a refetch supplying a corrected
  // thumbnail for the same episode retries it instead of staying on the
  // episode-number fallback for the rest of the mount.
  const [failedThumbnail, setFailedThumbnail] = useState<string | null>(null);
  const thumbnail = episode.thumbnail === failedThumbnail ? undefined : episode.thumbnail;
  const title = getEpisodeTitle(isSpoiler ? undefined : episode.title, episode.episode);
  const airDate = formatAirDate(episode.releaseDate);

  return (
    <div className='group relative'>
      <button
        type='button'
        ref={resumeRef}
        onClick={() => onPlay(episode)}
        className={cn(
          'relative block aspect-video w-full overflow-hidden rounded-lg border bg-zinc-900 text-left transition-colors duration-200',
          'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/50',
          isResume ? 'border-white/15' : 'border-white/[0.08]',
        )}
      >
        {thumbnail ? (
          <RemoteImage
            src={thumbnail}
            alt={title}
            className={cn(
              'absolute inset-0 h-full w-full object-cover transition-[scale,filter] duration-500',
              isSpoiler
                ? 'scale-110 blur-md'
                : 'group-hover:scale-[1.02] group-hover:brightness-110',
            )}
            loading='lazy'
            onError={() => setFailedThumbnail(episode.thumbnail ?? null)}
          />
        ) : (
          <div className='absolute inset-0 flex items-center justify-center bg-linear-to-br from-zinc-800 to-zinc-900 text-xl font-bold text-white/20 transition-colors duration-200 group-hover:text-white/30'>
            {episode.episode}
          </div>
        )}

        <div className='pointer-events-none absolute inset-0 bg-linear-to-t from-black/90 via-black/25 to-black/5' />

        <div className='absolute left-2 top-2 flex items-center gap-1.5'>
          <span className='flex h-5 items-center rounded-md border border-white/10 bg-black/60 px-1.5 text-[10px] font-semibold leading-none tabular-nums text-white/90 backdrop-blur-xs'>
            E{episode.episode}
          </span>
          {isResume && (
            <span className='flex h-5 items-center rounded-md bg-white px-1.5 text-[10px] font-bold uppercase leading-none tracking-[0.08em] text-black'>
              Resume
            </span>
          )}
        </div>

        <div className='pointer-events-none absolute inset-0 z-10 flex items-center justify-center opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100'>
          <div className='flex h-9 w-9 items-center justify-center rounded-full bg-black/45 backdrop-blur-xs'>
            <Play className='ml-0.5 h-4 w-4 fill-white text-white' />
          </div>
        </div>

        <div className='pointer-events-none absolute inset-x-0 bottom-0 z-10 p-3'>
          <h4 className='line-clamp-2 text-sm font-medium leading-snug text-white drop-shadow-md'>
            {title}
          </h4>
          {airDate && (
            <p className='mt-0.5 truncate text-[11px] font-medium text-white/50 drop-shadow-sm'>
              {airDate}
            </p>
          )}
        </div>

        <WatchProgressStrip percent={progressPercent} className='z-20' />
      </button>

      {onToggleWatched && (
        <button
          type='button'
          aria-pressed={isWatched}
          aria-label={`Mark ${formatSeasonEpisode(episode.season, episode.episode) || `episode ${episode.episode}`} as ${isWatched ? 'unwatched' : 'watched'}`}
          title={isWatched ? 'Mark as unwatched' : 'Mark as watched'}
          onClick={() => onToggleWatched(episode)}
          className={cn(
            'absolute right-1 top-1 z-30 flex h-11 w-11 items-center justify-center',
            'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/50 rounded-full',
          )}
        >
          <span
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-full border backdrop-blur-xs transition-colors duration-200',
              isWatched
                ? 'border-white bg-white text-black'
                : 'border-white/15 bg-black/55 text-white/60 hover:border-white/30 hover:text-white',
            )}
          >
            <Check className='h-3.5 w-3.5' strokeWidth={3} />
          </span>
        </button>
      )}
    </div>
  );
}

export const EpisodeCard = memo(EpisodeCardInner);
