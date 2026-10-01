import { ArrowLeft, Loader2, Play, RotateCcw, X } from 'lucide-react';
import { memo } from 'react';
import { RemoteImage } from '@/components/remote-image';
import type { Episode } from '@/lib/api';
import { cn, formatSeasonEpisode, isHttpUrl } from '@/lib/utils';

// Presentational player states, memoized like PlayerActionOverlays: props are
// primitives or stable callbacks so unchanged overlays skip the commit.

const ERROR_SECONDARY_BUTTON_CLASS =
  'rounded-lg border border-white/20 bg-white/5 px-4 py-2 text-sm font-medium text-white hover:bg-white/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30';
/** Up Next and End cards share one floating slot above the expanded chrome. */
const EOF_CARD_SLOT_CLASS =
  'animate-in fade-in slide-in-from-bottom-4 zoom-in-95 duration-300 absolute right-6 bottom-28 z-45 flex items-center';
const EOF_GLASS_CLASS =
  'border border-white/10 bg-zinc-950/85 shadow-2xl shadow-black/60 backdrop-blur-xl';
const EOF_EYEBROW_CLASS =
  'text-[10px] font-semibold uppercase tracking-[0.22em] leading-none text-white/40';

function EofCardThumbnail({ src }: { src: string }) {
  return (
    <RemoteImage
      src={src}
      alt=''
      className='h-14 w-24 shrink-0 rounded-lg object-cover'
      loading='lazy'
    />
  );
}

interface PlayerErrorOverlayProps {
  message: string;
  onRetry: () => void;
  onChooseStream: () => void;
  onBack: () => void;
}

export const PlayerErrorOverlay = memo(function PlayerErrorOverlay({
  message,
  onRetry,
  onChooseStream,
  onBack,
}: PlayerErrorOverlayProps) {
  return (
    <div
      role='alert'
      className='absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/85 backdrop-blur-md px-6 text-center animate-in fade-in zoom-in-95 duration-200'
    >
      <X className='w-12 h-12 text-red-400/90 mb-4' strokeWidth={1.5} />
      <h2 className='text-2xl font-bold mb-2 tracking-tight'>Playback Error</h2>
      <p className='text-zinc-400 mb-6 max-w-sm text-sm leading-relaxed'>{message}</p>
      <div className='flex items-center gap-3'>
        <button
          type='button'
          onClick={onRetry}
          className='rounded-lg bg-white px-4 py-2 text-sm font-semibold text-black transition-colors hover:bg-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60'
        >
          Try Again
        </button>
        <button type='button' onClick={onChooseStream} className={ERROR_SECONDARY_BUTTON_CLASS}>
          Choose Stream
        </button>
        <button type='button' onClick={onBack} className={ERROR_SECONDARY_BUTTON_CLASS}>
          Go Back
        </button>
      </div>
    </div>
  );
});

interface PlayerLoadingOverlayProps {
  isResolving: boolean;
  headline: string;
  detail?: string;
  /** Title logo carried on the route state — brands the card while the
      resolve/buffer pipeline runs. */
  logo?: string;
  /** Parent holds the mount alive briefly after the loading flag clears so
      the card dissolves out instead of popping off mid-reveal. */
  exiting?: boolean;
  onChooseStream: () => void;
  onBack: () => void;
}

export const PlayerLoadingOverlay = memo(function PlayerLoadingOverlay({
  isResolving,
  headline,
  detail,
  logo,
  exiting,
  onChooseStream,
  onBack,
}: PlayerLoadingOverlayProps) {
  return (
    <div className='pointer-events-none absolute inset-0 z-50 flex items-center justify-center'>
      {/* Entrance delay doubles as a debounce: a warm resolve+init can land
          under ~350ms, so the card unmounts before painting instead of
          flashing for a frame. `fill-mode-backwards` holds opacity-0 through
          the delay. */}
      <div
        className={cn(
          'mx-4 w-full max-w-xs rounded-3xl border border-white/[0.07] bg-zinc-950/70 px-5 py-4 shadow-2xl shadow-black/60 backdrop-blur-2xl',
          exiting
            ? 'animate-out fade-out zoom-out-95 duration-200 fill-mode-forwards'
            : 'animate-in fade-in zoom-in-95 duration-200 fill-mode-backwards [animation-delay:350ms] motion-reduce:[animation-delay:0ms]',
        )}
      >
        {isHttpUrl(logo) && (
          <RemoteImage
            src={logo}
            alt=''
            loading='lazy'
            className='mb-3.5 h-8 max-w-44 object-contain object-left opacity-90'
          />
        )}
        <div className='flex items-center gap-3'>
          <div className='flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl border border-white/[0.06] bg-white/[0.04]'>
            <Loader2 className='h-4 w-4 animate-spin text-white/80' />
          </div>

          <div className='min-w-0 flex-1'>
            <p className='mb-0.5 text-[10px] font-semibold uppercase tracking-[0.22em] leading-none text-white/35'>
              {isResolving ? 'Resolving' : 'Starting'}
            </p>
            <p className='text-sm font-semibold leading-snug text-white'>{headline}</p>
          </div>
        </div>

        {detail && <p className='mt-2 text-xs leading-relaxed text-white/45'>{detail}</p>}

        <div className='relative mt-3 h-[3px] overflow-hidden rounded-full bg-white/[0.08]'>
          <div className='absolute inset-y-0 w-1/3 rounded-full bg-linear-to-r from-transparent via-white/70 to-transparent animate-[progress-slide_1.6s_linear_infinite]' />
        </div>

        <div className='pointer-events-auto mt-3 flex items-center gap-2'>
          <button
            type='button'
            onClick={onChooseStream}
            className='flex-1 rounded-lg border border-white/15 bg-white/[0.06] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30'
          >
            Choose Stream
          </button>
          <button
            type='button'
            onClick={onBack}
            className='flex-1 rounded-lg px-3 py-1.5 text-xs font-medium text-white/50 transition-colors hover:bg-white/[0.06] hover:text-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30'
          >
            Go Back
          </button>
        </div>
      </div>
    </div>
  );
});

interface PlayerIdleOverlayProps {
  visible: boolean;
  isFullscreen: boolean;
  /** Title logo — route state first, fetched details as fallback. Falls
      back to the plain title text. */
  logo?: string;
  title?: string;
  /** e.g. "S2:E10" — omitted for movies. */
  episodeLabel?: string;
  episodeTitle?: string;
  overview?: string;
}

// Idle "you're watching" card for long zero-input stretches during healthy
// playback. Timing and dismissal live in usePlayerIdleOverlay; this is purely
// presentational. Rows stagger on the container's ease for one reveal.
export const PlayerIdleOverlay = memo(function PlayerIdleOverlay({
  visible,
  isFullscreen,
  logo,
  title,
  episodeLabel,
  episodeTitle,
  overview,
}: PlayerIdleOverlayProps) {
  const row = (delay: string) =>
    cn(
      'transition-[opacity,translate] duration-500 ease-out motion-reduce:transition-opacity',
      visible ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0',
      visible && delay,
    );
  return (
    <div
      aria-hidden={!visible}
      className={cn(
        'pointer-events-none absolute inset-0 z-30 transition-[opacity,visibility] duration-700 ease-out',
        visible ? 'visible opacity-100' : 'invisible opacity-0',
      )}
    >
      {/* Slight even dim plus a lower-third pool so the card text stays
          legible without washing the frame out. */}
      <div className='absolute inset-0 bg-black/35' />
      <div className='absolute inset-x-0 bottom-0 h-3/5 bg-linear-to-t from-black/70 via-black/25 to-transparent' />

      <div
        className={cn(
          'absolute bottom-32 max-w-3xl',
          // Clears the docked sidebar the same way the chrome overlay does.
          isFullscreen ? 'left-10' : 'left-[96px]',
        )}
      >
        <p
          className={cn(
            'text-xs font-semibold uppercase tracking-[0.24em] text-white/50',
            row('delay-100'),
          )}
        >
          You're watching
        </p>
        {isHttpUrl(logo) ? (
          <RemoteImage
            src={logo}
            alt={title ?? ''}
            loading='lazy'
            className={cn(
              'mt-6 max-h-40 w-auto max-w-lg object-contain object-left drop-shadow-[0_10px_40px_rgba(0,0,0,0.75)]',
              row('delay-150'),
            )}
          />
        ) : (
          title && (
            <h2
              className={cn(
                'mt-6 text-5xl font-bold leading-[1.04] tracking-[-0.025em] text-white drop-shadow-[0_10px_40px_rgba(0,0,0,0.75)] md:text-6xl',
                row('delay-150'),
              )}
            >
              {title}
            </h2>
          )
        )}
        {episodeLabel && (
          <p
            className={cn(
              'mt-6 text-sm font-semibold uppercase tracking-[0.2em] text-white/55',
              row('delay-200'),
            )}
          >
            {episodeLabel}
          </p>
        )}
        {episodeTitle && (
          <h3
            className={cn('mt-2 text-2xl font-semibold leading-snug text-white', row('delay-300'))}
          >
            {episodeTitle}
          </h3>
        )}
        {overview && (
          <p
            className={cn(
              'mt-3 line-clamp-3 max-w-xl text-sm leading-relaxed text-white/60',
              row('delay-500'),
            )}
          >
            {overview}
          </p>
        )}
      </div>
    </div>
  );
});

interface PlayerPauseResumeButtonProps {
  visible: boolean;
  onResume: () => Promise<void>;
}

// Paused-state center resume — bare icon flash, no chrome: keyframe pop on
// pause, transition out on resume.
export const PlayerPauseResumeButton = memo(function PlayerPauseResumeButton({
  visible,
  onResume,
}: PlayerPauseResumeButtonProps) {
  return (
    <div className='pointer-events-none absolute inset-0 z-45 flex items-center justify-center'>
      <button
        type='button'
        aria-label='Resume playback'
        tabIndex={visible ? 0 : -1}
        onClick={(e) => {
          e.stopPropagation();
          void onResume().catch(() => undefined);
        }}
        className={cn(
          'flex h-20 w-20 items-center justify-center rounded-full outline-hidden text-white',
          'transition-[opacity,scale] duration-200 ease-out',
          'hover:scale-105 active:scale-95 focus-visible:scale-105',
          visible
            ? 'pointer-events-auto scale-100 opacity-100 animate-[pause-pop_320ms_cubic-bezier(0.34,1.3,0.5,1)] motion-reduce:animate-none'
            : 'pointer-events-none scale-90 opacity-0',
        )}
      >
        <Play
          className='ml-1 h-16 w-16 fill-white drop-shadow-[0_6px_28px_rgba(0,0,0,0.75)]'
          strokeWidth={1.5}
        />
      </button>
    </div>
  );
});

interface PlayerUpNextCardProps {
  episode: Episode;
  thumbnail?: string;
  /** Auto-play countdown seconds, or null when the card is manual-only. */
  autoPlaySecondsLeft: number | null;
  autoPlayDurationSeconds: number;
  onCancelAutoPlay: () => void;
  onPlayNext: () => void;
}

const UP_NEXT_RING_RADIUS = 13;
const UP_NEXT_RING_CIRCUMFERENCE = 2 * Math.PI * UP_NEXT_RING_RADIUS;

// EOF "Up Next": mpv ended and a next episode exists — one click (or N) runs
// the silent auto-resolve and keeps watching. With the auto-play preference
// on, a countdown ring arms the same action; the cancel chip disarms it.
export const PlayerUpNextCard = memo(function PlayerUpNextCard({
  episode,
  thumbnail,
  autoPlaySecondsLeft,
  autoPlayDurationSeconds,
  onCancelAutoPlay,
  onPlayNext,
}: PlayerUpNextCardProps) {
  const countingDown = autoPlaySecondsLeft !== null;
  const ringProgress = countingDown
    ? Math.min(1, Math.max(0, autoPlaySecondsLeft / autoPlayDurationSeconds))
    : 0;
  return (
    <div data-player-interactive className={cn(EOF_CARD_SLOT_CLASS, 'gap-2')}>
      <button
        type='button'
        onClick={(e) => {
          e.stopPropagation();
          onPlayNext();
        }}
        className={cn(
          EOF_GLASS_CLASS,
          'group/upnext flex items-center gap-3 rounded-2xl p-2.5 pr-4 text-left transition-colors hover:bg-zinc-900/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40',
        )}
      >
        {thumbnail && <EofCardThumbnail src={thumbnail} />}
        <div className='min-w-0'>
          <p className={EOF_EYEBROW_CLASS}>Up Next</p>
          <p className='mt-1 truncate text-sm font-semibold leading-snug text-white'>
            {formatSeasonEpisode(episode.season, episode.episode)}
            {episode.title ? ` · ${episode.title}` : ''}
          </p>
          <p className='mt-0.5 text-[11px] leading-none text-white/45'>
            {countingDown ? (
              <>
                Playing in <span aria-hidden='true'>{autoPlaySecondsLeft}s</span>
                <span className='sr-only'>— press N or click to play now</span>
              </>
            ) : (
              'Press N or click to play'
            )}
          </p>
        </div>
        <div className='relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/15 bg-white/5 transition-colors group-hover/upnext:bg-white/15'>
          {countingDown && (
            <svg
              aria-hidden='true'
              className='absolute inset-0 h-full w-full -rotate-90'
              viewBox='0 0 32 32'
            >
              <circle
                cx='16'
                cy='16'
                r={UP_NEXT_RING_RADIUS}
                fill='none'
                stroke='currentColor'
                strokeWidth='2'
                strokeLinecap='round'
                strokeDasharray={UP_NEXT_RING_CIRCUMFERENCE}
                strokeDashoffset={UP_NEXT_RING_CIRCUMFERENCE * (1 - ringProgress)}
                className='text-white/70 transition-[stroke-dashoffset] duration-1000 ease-linear motion-reduce:transition-none'
              />
            </svg>
          )}
          <Play className='ml-0.5 h-3.5 w-3.5 fill-white text-white' />
        </div>
      </button>
      {countingDown && (
        <button
          type='button'
          aria-label='Cancel autoplay'
          title='Cancel autoplay'
          onClick={(e) => {
            e.stopPropagation();
            onCancelAutoPlay();
          }}
          className={cn(
            EOF_GLASS_CLASS,
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white/60 transition-colors hover:bg-zinc-900/85 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40',
          )}
        >
          <X className='h-3.5 w-3.5' />
        </button>
      )}
    </div>
  );
});

interface PlayerEndCardProps {
  title: string;
  thumbnail?: string;
  /** 'card' floats above the expanded player's chrome (the Up Next slot);
      'strip' docks inside the mini player's video surface. */
  variant?: 'card' | 'strip';
  onReplay: () => void;
  onBackToTitle: () => void;
}

// EOF without a next episode (movies, finales): replay or head back instead
// of idling on a frozen last frame. The mini strip keeps it visible under
// hover — the docked chrome has no replay control of its own.
export const PlayerEndCard = memo(function PlayerEndCard({
  title,
  thumbnail,
  variant = 'card',
  onReplay,
  onBackToTitle,
}: PlayerEndCardProps) {
  if (variant === 'strip') {
    return (
      <div
        data-player-interactive
        className='absolute inset-x-2 bottom-2.5 z-[25] flex items-center gap-1.5'
      >
        <button
          type='button'
          onClick={(e) => {
            e.stopPropagation();
            onReplay();
          }}
          className='flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-white/10 bg-black/70 py-1.5 pl-1.5 pr-2.5 text-left backdrop-blur-md transition-colors duration-200 hover:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40'
        >
          {thumbnail && (
            <RemoteImage
              src={thumbnail}
              alt=''
              className='h-7 w-12 shrink-0 rounded object-cover'
            />
          )}
          <span className='min-w-0 flex-1'>
            <span className='block text-[8.5px] font-semibold uppercase tracking-[0.18em] leading-none text-white/40'>
              Finished
            </span>
            <span className='mt-0.5 block truncate text-[11px] font-medium leading-tight text-white/90'>
              Watch again
            </span>
          </span>
          <RotateCcw className='ml-0.5 h-3.5 w-3.5 shrink-0 text-white/90' />
        </button>
        <button
          type='button'
          aria-label='Back to title'
          title='Back to title'
          onClick={(e) => {
            e.stopPropagation();
            onBackToTitle();
          }}
          className='flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-black/70 text-white/60 backdrop-blur-md transition-colors duration-200 hover:bg-black/80 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40'
        >
          <ArrowLeft className='h-3.5 w-3.5' />
        </button>
      </div>
    );
  }

  return (
    <div
      data-player-interactive
      className={cn(EOF_CARD_SLOT_CLASS, EOF_GLASS_CLASS, 'gap-3 rounded-2xl p-2.5 pr-3')}
    >
      {thumbnail && <EofCardThumbnail src={thumbnail} />}
      <div className='min-w-0'>
        <p className={EOF_EYEBROW_CLASS}>Finished</p>
        <p className='mt-1 max-w-56 truncate text-sm font-semibold leading-snug text-white'>
          {title}
        </p>
        <div className='mt-2 flex items-center gap-1.5'>
          <button
            type='button'
            onClick={(e) => {
              e.stopPropagation();
              onReplay();
            }}
            className='flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-black transition-colors hover:bg-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/40'
          >
            <RotateCcw className='h-3 w-3' />
            Watch again
          </button>
          <button
            type='button'
            onClick={(e) => {
              e.stopPropagation();
              onBackToTitle();
            }}
            className='rounded-lg border border-white/20 bg-white/5 px-3 py-1.5 text-xs font-medium text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30'
          >
            Back to title
          </button>
        </div>
      </div>
    </div>
  );
});
