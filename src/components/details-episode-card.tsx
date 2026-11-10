import { useId, useRef, type Ref } from 'react';
import { Check, CheckCheck, ChevronLeft, Link2, Play, RotateCcw } from 'lucide-react';
import type { Episode } from '@/lib/api';
import { InlineMenu } from '@/components/inline-menu';
import { RemoteImage } from '@/components/remote-image';
import { WatchProgressStrip } from '@/components/watch-progress-strip';
import { useFailedSrc } from '@/hooks/use-failed-src';
import { useInlineMenu } from '@/hooks/use-inline-menu';
import { useLocalDay } from '@/hooks/use-local-day';
import { copyText } from '@/lib/notify';
import { formatAirDate, parseLocalScheduleDate, SHORT_DATE_FORMATTER } from '@/lib/schedule-dates';
import { cn, formatSeasonEpisode, getEpisodeTitle } from '@/lib/utils';

export type EpisodeEmphasis = 'resume' | 'next' | null;

const EMPHASIS_LABELS = { resume: 'Resume', next: 'Up next' } as const;

interface EpisodeCardProps {
  episode: Episode;
  emphasis: EpisodeEmphasis;
  isSpoiler: boolean;
  isWatched: boolean;
  isAired: boolean;
  isWatchedDisabled: boolean;
  isWatchedPending: boolean;
  progressPercent: number;
  remainingText: string | null;
  resumeRef?: Ref<HTMLButtonElement>;
  shareLink: string;
  onPlay: (episode: Episode) => void;
  onPlayFromStart: (episode: Episode) => void;
  onToggleWatched?: (episode: Episode) => void;
  /** Present when earlier aired episodes of the season are still unwatched. */
  onMarkWatchedThrough?: (episode: Episode) => void;
}

export function EpisodeCard({
  episode,
  emphasis,
  isSpoiler,
  isWatched,
  isAired,
  isWatchedDisabled,
  isWatchedPending,
  progressPercent,
  remainingText,
  resumeRef,
  shareLink,
  onPlay,
  onPlayFromStart,
  onToggleWatched,
  onMarkWatchedThrough,
}: EpisodeCardProps) {
  const localDay = useLocalDay();
  const [thumbnail, onThumbnailError] = useFailedSrc(episode.thumbnail);
  const descriptionId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const menu = useInlineMenu({
    rootRef,
    returnFocus: () => rootRef.current?.querySelector('button'),
  });
  const watchedLocked = isWatchedDisabled || isWatchedPending;

  const description = isSpoiler
    ? 'Description hidden to prevent spoilers.'
    : episode.overview?.trim() || null;
  const title = getEpisodeTitle(isSpoiler ? undefined : episode.title, episode.episode);
  const coordinates = formatSeasonEpisode(episode.season, episode.episode);
  const airDate = formatAirDate(episode.releaseDate, localDay);
  const releaseDate = !isAired ? parseLocalScheduleDate(episode.releaseDate) : null;
  const releaseLabel = isAired
    ? airDate
    : releaseDate
      ? `Not Yet Aired · ${SHORT_DATE_FORMATTER.format(releaseDate)}`
      : 'Not Yet Aired';
  const watchButtonLabel = `${emphasis === 'resume' ? 'Resume' : 'Play'} ${coordinates}: ${title}${releaseLabel ? `, ${releaseLabel}` : ''}${remainingText && !isWatched ? ` (${remainingText})` : ''}`;

  return (
    <div ref={rootRef} className='group/card relative min-w-0' {...menu.rootProps}>
      <button
        type='button'
        ref={resumeRef}
        data-episode-season={episode.season}
        data-episode-number={episode.episode}
        onClick={() => onPlay(episode)}
        aria-label={watchButtonLabel}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={menu.presence.mounted ? -1 : undefined}
        className={cn(
          'block w-full rounded-lg text-left',
          'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-(--accent-act)/60',
          menu.presence.mounted && 'pointer-events-none',
        )}
      >
        <span className='relative block aspect-video w-full overflow-hidden rounded-lg bg-zinc-900'>
          {thumbnail ? (
            <RemoteImage
              src={thumbnail}
              alt=''
              className={cn(
                'absolute inset-0 h-full w-full object-cover',
                isSpoiler && 'scale-110 blur-md',
                isWatched && 'opacity-70!',
              )}
              loading='lazy'
              fadeIn
              onError={onThumbnailError}
            />
          ) : (
            <span className='absolute inset-0 flex items-center justify-center bg-zinc-900 text-2xl font-semibold text-white/20'>
              {episode.episode}
            </span>
          )}

          <span
            aria-hidden='true'
            className='absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-black/0 ring-1 ring-inset ring-white/[0.07] transition-[background-color,box-shadow] duration-200 ease-out group-hover/card:bg-black/45 group-hover/card:ring-white/15 motion-reduce:transition-none'
          >
            <span className='flex h-11 w-11 scale-90 items-center justify-center rounded-full bg-white/15 opacity-0 ring-1 ring-inset ring-white/20 backdrop-blur-md transition-[opacity,transform] duration-200 ease-out group-hover/card:scale-100 group-hover/card:opacity-100 motion-reduce:transition-none'>
              <Play className='ml-0.5 h-4 w-4 fill-white text-white' />
            </span>
          </span>
          {remainingText && !isWatched && (
            <span className='absolute bottom-2.5 right-2 z-20 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white/90'>
              {remainingText}
            </span>
          )}
          <WatchProgressStrip percent={progressPercent} className='z-20' />
        </span>
        <span className={cn('block px-0.5 pb-1 pt-2.5', menu.presence.mounted && 'opacity-0')}>
          <span
            title={title}
            className='line-clamp-2 text-[15px] font-medium leading-5 text-zinc-100'
          >
            {title}
          </span>
          <span className='mt-1 flex min-w-0 items-center gap-1.5 text-[12px] leading-4 tabular-nums text-zinc-400'>
            {emphasis && (
              <>
                <span className='shrink-0 font-semibold text-(--accent-act)'>
                  {EMPHASIS_LABELS[emphasis]}
                </span>
                <span aria-hidden='true'>·</span>
              </>
            )}
            <span className='shrink-0 font-medium text-zinc-400'>Episode {episode.episode}</span>
            {releaseLabel && (
              <>
                <span aria-hidden='true'>·</span>
                <span className='truncate'>{releaseLabel}</span>
              </>
            )}
          </span>
          {description && (
            <span
              id={descriptionId}
              className='mt-2 line-clamp-2 text-[13px] leading-5 text-zinc-400'
            >
              {description}
            </span>
          )}
        </span>
      </button>
      {onToggleWatched && (
        <button
          type='button'
          aria-disabled={watchedLocked || undefined}
          aria-busy={isWatchedPending || undefined}
          aria-label={`Mark ${coordinates} as ${isWatched ? 'unwatched' : 'watched'}`}
          tabIndex={menu.presence.mounted ? -1 : undefined}
          onClick={() => {
            if (!watchedLocked) onToggleWatched(episode);
          }}
          className={cn(
            'group/watch absolute right-1 top-1 z-30 flex h-11 w-11 items-center justify-center rounded-lg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-(--accent-act)/60 aria-disabled:cursor-default',
            menu.presence.mounted && 'pointer-events-none opacity-0',
          )}
        >
          <span
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-md border transition-colors duration-150',
              isWatched
                ? 'border-(--accent-act) bg-(--accent-act) text-(--on-accent-act)'
                : 'border-white/15 bg-black/65 text-white/65 group-not-aria-disabled/watch:group-hover/watch:border-white/30 group-not-aria-disabled/watch:group-hover/watch:text-white group-focus-visible/watch:text-white',
            )}
          >
            <Check aria-hidden='true' className='h-3.5 w-3.5' strokeWidth={2.5} />
          </span>
        </button>
      )}
      <InlineMenu
        presence={menu.presence}
        label={`More actions for ${coordinates}`}
        className='z-40 rounded-lg border border-white/[0.08] bg-zinc-950/85 backdrop-blur-md'
        onAction={menu.close}
        actions={[
          { key: 'back', label: 'Back', icon: ChevronLeft, muted: true, onSelect: menu.close },
          {
            key: 'play-from-start',
            label: 'Play from start',
            icon: RotateCcw,
            onSelect: () => onPlayFromStart(episode),
          },
          onToggleWatched && {
            key: 'toggle-watched',
            label: isWatched ? 'Mark unwatched' : 'Mark watched',
            icon: Check,
            disabled: watchedLocked,
            onSelect: () => onToggleWatched(episode),
          },
          onMarkWatchedThrough && {
            key: 'watched-through',
            label: 'Mark watched up to here',
            icon: CheckCheck,
            disabled: isWatchedDisabled,
            onSelect: () => onMarkWatchedThrough(episode),
          },
          {
            key: 'copy-link',
            label: 'Copy episode link',
            icon: Link2,
            onSelect: () =>
              void copyText(shareLink, {
                success: 'Episode link copied',
                successDetail: `${coordinates} · ${title}`,
                failure: 'Could not copy episode link',
              }),
          },
        ]}
      />
    </div>
  );
}
