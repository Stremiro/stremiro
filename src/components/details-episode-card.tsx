import { memo, useId, type Ref } from 'react';
import { format } from 'date-fns';
import { Check, Play } from 'lucide-react';
import type { Episode, TitleWatchProgress, WatchProgress } from '@/lib/api';
import { RemoteImage } from '@/components/remote-image';
import { WatchProgressStrip } from '@/components/watch-progress-strip';
import { useFailedSrc } from '@/hooks/use-failed-src';
import { formatAirDate, parseLocalScheduleDate } from '@/lib/schedule-dates';
import { cn, formatSeasonEpisode, getEpisodeTitle } from '@/lib/utils';

export function isEpisodeSpoiler(
  episode: Episode,
  spoilerProtection: boolean,
  watchedEpisodeCeiling: TitleWatchProgress['watchedEpisodeCeiling'] | undefined,
  progress: WatchProgress | undefined,
  isCurrent = false,
): boolean {
  const ceiling = watchedEpisodeCeiling?.[episode.season];
  return (
    spoilerProtection &&
    !isCurrent &&
    !progress?.has_started_watching &&
    (ceiling === undefined || episode.episode > ceiling)
  );
}

interface EpisodeCardProps {
  episode: Episode;
  isResume: boolean;
  isSpoiler: boolean;
  isWatched: boolean;
  isAired?: boolean;
  isWatchedDisabled?: boolean;
  isWatchedPending: boolean;
  progressPercent: number;
  remainingText?: string | null;
  resumeRef?: Ref<HTMLButtonElement>;
  onPlay: (episode: Episode) => void;
  onToggleWatched?: (episode: Episode) => void;
}

function EpisodeCardInner({
  episode,
  isResume,
  isSpoiler,
  isWatched,
  isAired = true,
  isWatchedDisabled = false,
  isWatchedPending,
  progressPercent,
  remainingText,
  resumeRef,
  onPlay,
  onToggleWatched,
}: EpisodeCardProps) {
  const [thumbnail, onThumbnailError] = useFailedSrc(episode.thumbnail);
  const descriptionId = useId();
  const description = isSpoiler
    ? 'Description hidden to prevent spoilers.'
    : episode.overview?.trim() || null;
  const title = getEpisodeTitle(isSpoiler ? undefined : episode.title, episode.episode);
  const airDate = formatAirDate(episode.releaseDate);
  const releaseDate = !isAired ? parseLocalScheduleDate(episode.releaseDate) : null;
  const releaseLabel = isAired
    ? airDate
    : releaseDate
      ? `Not Yet Aired · ${format(releaseDate, 'MMM d')}`
      : 'Not Yet Aired';
  const watchButtonLabel = `${isResume ? 'Resume' : 'Play'} ${formatSeasonEpisode(episode.season, episode.episode)}: ${title}${releaseLabel ? `, ${releaseLabel}` : ''}${remainingText && !isWatched ? ` (${remainingText})` : ''}`;

  return (
    <div className='relative'>
      <button
        type='button'
        ref={resumeRef}
        data-episode-season={episode.season}
        data-episode-number={episode.episode}
        onClick={() => onPlay(episode)}
        aria-label={watchButtonLabel}
        aria-describedby={description ? descriptionId : undefined}
        className={cn(
          'group/episode relative block aspect-video w-full overflow-hidden rounded-lg border bg-zinc-900 text-left transition-colors duration-200',
          'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-(--accent-act)/60',
          isResume
            ? 'border-[rgb(var(--accent-act-rgb)/0.35)] hover:border-[rgb(var(--accent-act-rgb)/0.55)]'
            : 'border-white/[0.08] hover:border-white/20',
        )}
      >
        {thumbnail ? (
          <RemoteImage
            src={thumbnail}
            alt=''
            className={cn(
              'absolute inset-0 h-full w-full object-cover',
              isSpoiler && 'scale-110 blur-md',
            )}
            loading='lazy'
            fadeIn
            onError={onThumbnailError}
          />
        ) : (
          <div className='absolute inset-0 flex items-center justify-center bg-zinc-900 text-2xl font-semibold text-white/20'>
            {episode.episode}
          </div>
        )}

        <div className='pointer-events-none absolute inset-x-0 bottom-0 h-3/4 bg-linear-to-t from-black/90 via-black/45 to-transparent' />
        <div className='pointer-events-none absolute inset-0 bg-linear-to-t from-black/95 via-black/75 to-black/30 opacity-0 transition-opacity duration-300 group-hover/episode:opacity-100 group-focus-visible/episode:opacity-100 motion-reduce:transition-none' />

        {isResume && (
          <span className='absolute left-2.5 top-2.5 flex h-[22px] items-center gap-1.5 rounded-[4px] border border-white/[0.1] bg-black/60 pl-1.5 pr-2 text-[10.5px] font-semibold uppercase leading-none tracking-[0.08em] text-white/90 shadow-[0_4px_14px_-4px_rgba(0,0,0,0.6)] backdrop-blur-md'>
            <Play aria-hidden='true' className='h-2.5 w-2.5 fill-current text-(--accent-act)' />
            Resume
          </span>
        )}

        <div className='pointer-events-none absolute inset-x-0 bottom-0 z-10 p-3.5'>
          <p className='flex min-w-0 items-center gap-1.5 text-[11.5px] font-medium tabular-nums text-white/70'>
            <span className='shrink-0 font-semibold text-white/90'>E{episode.episode}</span>
            {releaseLabel && (
              <>
                <span aria-hidden='true'>·</span>
                <span className='truncate'>{releaseLabel}</span>
              </>
            )}
            {remainingText && !isWatched && (
              <>
                <span aria-hidden='true'>·</span>
                <span className='shrink-0'>{remainingText}</span>
              </>
            )}
          </p>
          <h4 className='mt-0.5 line-clamp-2 text-[15px] font-semibold leading-snug text-white drop-shadow-md'>
            {title}
          </h4>
          {description && (
            <div className='grid grid-rows-[0fr] opacity-0 transition-[grid-template-rows,opacity] duration-300 ease-out group-hover/episode:grid-rows-[1fr] group-hover/episode:opacity-100 group-focus-visible/episode:grid-rows-[1fr] group-focus-visible/episode:opacity-100 motion-reduce:transition-none'>
              <div className='min-h-0 overflow-hidden'>
                <p
                  id={descriptionId}
                  className='line-clamp-3 pt-1.5 text-[12.5px] leading-[1.45] text-zinc-200'
                >
                  {description}
                </p>
              </div>
            </div>
          )}
        </div>

        <WatchProgressStrip percent={progressPercent} className='z-20' />
      </button>
      {onToggleWatched && (
        <button
          type='button'
          aria-pressed={isWatched}
          aria-disabled={isWatchedDisabled || isWatchedPending || undefined}
          aria-busy={isWatchedPending || undefined}
          aria-label={`Mark ${formatSeasonEpisode(episode.season, episode.episode) || `episode ${episode.episode}`} as ${isWatched ? 'unwatched' : 'watched'}`}
          title={isWatched ? 'Mark as unwatched' : 'Mark as watched'}
          onClick={() => {
            if (!isWatchedDisabled && !isWatchedPending) onToggleWatched(episode);
          }}
          className='group/watch absolute right-1 top-1 z-30 flex h-11 w-11 items-center justify-center rounded-lg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-(--accent-act)/60 aria-disabled:cursor-default'
        >
          <span
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-md border transition-colors duration-150',
              isWatched
                ? 'border-(--accent-act) bg-(--accent-act) text-(--on-accent-act)'
                : 'border-white/15 bg-black/65 text-white/65 group-hover/watch:border-white/30 group-hover/watch:text-white group-focus-visible/watch:text-white',
            )}
          >
            <Check aria-hidden='true' className='h-3.5 w-3.5' strokeWidth={2.5} />
          </span>
        </button>
      )}
    </div>
  );
}

export const EpisodeCard = memo(EpisodeCardInner);
