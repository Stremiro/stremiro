import { ArrowLeft, Play, RotateCcw, TriangleAlert, X } from 'lucide-react';
import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { RemoteImage } from '@/components/remote-image';
import { usePlayerKeymap } from '@/hooks/use-app-ui-preferences';
import { useFailedSrc } from '@/hooks/use-failed-src';
import type { Episode } from '@/lib/api';
import { ariaKeyShortcuts, formatBindingKey, withShortcutHint } from '@/lib/player-keybindings';
import type { SubscribableStore } from '@/lib/subscribable-store';
import { clamp, cn, formatEpisodeHeading, isHttpUrl } from '@/lib/utils';

const ERROR_SECONDARY_BUTTON_CLASS =
  'rounded-lg border border-white/20 bg-white/5 px-4 py-2 text-sm font-medium text-white hover:bg-white/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30';
/** The expanded player's action lane owns placement above its measured chrome. */
const EOF_CARD_SLOT_CLASS =
  'pointer-events-auto flex min-w-0 max-w-full items-center animate-in fade-in duration-150 motion-reduce:animate-none';
const EOF_GLASS_CLASS = 'border border-white/10 bg-zinc-950/85 shadow-2xl shadow-black/60';
const EOF_EYEBROW_CLASS = 'text-[11px] font-medium leading-none text-white/65';

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
      className='absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/85 px-6 text-center animate-in fade-in duration-150 motion-reduce:animate-none'
    >
      <div className='max-h-full w-full overflow-y-auto overscroll-contain px-1 py-6'>
        <TriangleAlert
          aria-hidden='true'
          className='mx-auto w-12 h-12 text-red-400/90 mb-4'
          strokeWidth={1.5}
        />
        <h2 className='text-2xl font-bold mb-2 tracking-tight'>Playback Error</h2>
        <p className='mx-auto text-zinc-400 mb-6 max-w-sm wrap-anywhere text-sm leading-relaxed'>
          {message}
        </p>
        <div className='flex flex-wrap items-center justify-center gap-3'>
          <button
            type='button'
            onClick={onRetry}
            className='rounded-lg bg-white px-4 py-2 text-sm font-semibold text-black transition-colors hover:bg-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60'
          >
            Try again
          </button>
          <button type='button' onClick={onChooseStream} className={ERROR_SECONDARY_BUTTON_CLASS}>
            Choose stream
          </button>
          <button type='button' onClick={onBack} className={ERROR_SECONDARY_BUTTON_CLASS}>
            Go back
          </button>
        </div>
      </div>
    </div>
  );
});

const PLAYER_LOADING_STAGES = [
  { id: 'starting', label: 'Starting player' },
  { id: 'finding', label: 'Finding source' },
  { id: 'connecting', label: 'Connecting' },
  { id: 'buffering', label: 'Buffering' },
] as const;

interface PlayerLoadingOverlayProps {
  headline: string;
  detail?: string;
  /** Index into the starting → finding → connecting → buffering ladder. */
  stageIndex?: number;
  /** Title logo carried on the route state — brands the card while the resolve/buffer pipeline runs. */
  logo?: string;
  /** Details that may still supply a logo are loading — hold the logo slot instead of flashing the plain title. */
  logoPending?: boolean;
  /** Plain-text fallback when no logo is known, so the card always says what is opening. */
  title?: string;
  /** Short "S2:E4 · From 23:14" line naming where playback will land. */
  context?: string;
  /** Parent holds the mount briefly after the flag clears so the card dissolves out instead of popping off. */
  exiting?: boolean;
  onChooseStream: () => void;
  onBack: () => void;
}

export const PlayerLoadingOverlay = memo(function PlayerLoadingOverlay({
  headline,
  detail,
  stageIndex = 0,
  logo,
  logoPending,
  title,
  context,
  exiting,
  onChooseStream,
  onBack,
}: PlayerLoadingOverlayProps) {
  const [logoSrc, onLogoError] = useFailedSrc(isHttpUrl(logo) ? logo : null);
  // The session host keeps one instance for the whole launch, so the reveal never restarts mid-load.
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (exiting || revealed) return;
    // A CSS exit animation would paint a warm load that never finished its delayed entrance.
    const timer = window.setTimeout(() => setRevealed(true), 250);
    return () => window.clearTimeout(timer);
  }, [exiting, revealed]);
  if (!revealed) return null;

  return (
    <div className='pointer-events-none fixed inset-0 z-50 flex items-center justify-center'>
      <div
        inert={exiting}
        className={cn(
          'relative mx-4 w-full max-w-[22.5rem] overflow-hidden rounded-[14px] border border-white/[0.08] bg-zinc-950/80 px-5 pb-4 pt-5 shadow-2xl shadow-black/60 backdrop-blur-2xl motion-reduce:animate-none',
          exiting
            ? 'animate-out fade-out zoom-out-[0.98] duration-150 ease-in fill-mode-forwards'
            : 'animate-in fade-in zoom-in-[0.97] slide-in-from-bottom-1.5 duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]',
        )}
      >
        {(logoSrc || logoPending || title || context) && (
          <div className='mb-4 border-b border-white/[0.06] pb-4'>
            {logoSrc ? (
              <RemoteImage
                src={logoSrc}
                alt={title ?? ''}
                fadeIn
                onError={onLogoError}
                className='h-9 max-w-52 object-contain object-left'
              />
            ) : logoPending ? (
              <div aria-hidden='true' className='h-9' />
            ) : (
              title && (
                <p className='truncate text-[17px] font-semibold leading-9 tracking-tight text-white'>
                  {title}
                </p>
              )
            )}
            {context && (
              <p className='mt-2 truncate text-[12.5px] font-medium tabular-nums leading-none text-white/55'>
                {context}
              </p>
            )}
          </div>
        )}

        <p
          role='status'
          aria-live={exiting ? 'off' : 'polite'}
          aria-atomic='true'
          className='sr-only'
        >
          {[PLAYER_LOADING_STAGES[stageIndex].label, headline, detail].filter(Boolean).join('. ')}
        </p>
        <div aria-hidden='true'>
          <div className='flex items-center gap-2.5'>
            <span className='relative h-4 w-4 shrink-0'>
              <span className='absolute inset-0 rounded-full border-2 border-white/10' />
              <span className='absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-(--accent-act) [animation-duration:650ms]' />
            </span>
            <span
              key={stageIndex}
              className='min-w-0 truncate text-[14px] font-semibold leading-5 text-white animate-in fade-in slide-in-from-bottom-1 duration-150 motion-reduce:animate-none'
            >
              {PLAYER_LOADING_STAGES[stageIndex].label}
            </span>
            <span className='ml-auto text-[11px] font-medium tabular-nums leading-none text-white/35'>
              {stageIndex + 1}/{PLAYER_LOADING_STAGES.length}
            </span>
          </div>
          <div className='mt-3.5 flex gap-1'>
            {PLAYER_LOADING_STAGES.map((step, index) => (
              <div
                key={step.id}
                className={cn(
                  'relative h-[3px] flex-1 overflow-hidden rounded-full transition-colors duration-200',
                  index === stageIndex
                    ? 'bg-[rgb(var(--accent-prog-rgb)/0.22)]'
                    : 'bg-white/[0.08]',
                )}
              >
                {index === stageIndex && (
                  <div className='absolute inset-y-0 left-0 w-1/3 rounded-full bg-(--accent-prog) animate-[progress-slide_1s_cubic-bezier(0.45,0,0.55,1)_infinite] motion-reduce:hidden' />
                )}
                <div
                  className='absolute inset-0 origin-left rounded-full bg-(--accent-prog) transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]'
                  style={{ transform: `scaleX(${index < stageIndex ? 1 : 0})` }}
                />
              </div>
            ))}
          </div>
        </div>
        <p
          aria-hidden='true'
          className='mt-3 line-clamp-2 text-[12.5px] leading-snug text-white/50'
        >
          {[headline, detail].filter(Boolean).join(' · ')}
        </p>

        <div className='mt-4 flex items-center gap-1.5 pointer-events-auto'>
          <button
            type='button'
            onClick={onChooseStream}
            className='h-8 rounded-lg bg-white/[0.07] px-3 text-[12.5px] font-medium text-white/85 transition-colors hover:bg-white/[0.12] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30'
          >
            Choose stream
          </button>
          <button
            type='button'
            onClick={onBack}
            className='h-8 rounded-lg px-3 text-[12.5px] font-medium text-white/50 transition-colors hover:bg-white/[0.06] hover:text-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30'
          >
            Go back
          </button>
        </div>
      </div>
    </div>
  );
});

interface PlayerIdleOverlayProps {
  visible: boolean;
  isFullscreen: boolean;
  /** Title logo — route state first, fetched details as fallback; falls back to plain title text. */
  logo?: string;
  title?: string;
  /** e.g. "S2:E10" — omitted for movies. */
  episodeLabel?: string;
  episodeTitle?: string;
  overview?: string;
}

// Idle "you're watching" card for zero-input stretches while paused; timing/dismissal live in usePlayerIdleOverlay.
export const PlayerIdleOverlay = memo(function PlayerIdleOverlay({
  visible,
  isFullscreen,
  logo,
  title,
  episodeLabel,
  episodeTitle,
  overview,
}: PlayerIdleOverlayProps) {
  const [logoSrc, onLogoError] = useFailedSrc(isHttpUrl(logo) ? logo : null);
  return (
    <div
      aria-hidden={!visible}
      className={cn(
        'pointer-events-none absolute inset-0 z-30 transition-opacity duration-150 ease-out motion-reduce:transition-none',
        visible ? 'opacity-100' : 'opacity-0',
      )}
    >
      <div className='absolute inset-0 bg-black/25' />
      <div className='absolute inset-0 bg-linear-to-r from-black/75 via-black/30 to-transparent' />
      <div className='absolute inset-x-0 bottom-0 h-1/2 bg-linear-to-t from-black/65 to-transparent' />

      <div
        className={cn(
          'absolute bottom-[clamp(2rem,14vh,8rem)] right-8 max-h-[calc(100%-6rem)] max-w-2xl overflow-hidden',
          // Clears the docked sidebar the same way the chrome overlay does.
          isFullscreen ? 'left-10' : 'left-[96px]',
        )}
        style={{ fontFamily: '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif' }}
      >
        <p className='text-[15px] font-medium leading-6 tracking-normal text-white/85'>
          You're watching
        </p>
        {logoSrc ? (
          <RemoteImage
            src={logoSrc}
            alt={title ?? ''}
            loading='lazy'
            onError={onLogoError}
            className='mt-4 max-h-28 w-auto max-w-full object-contain object-left drop-shadow-[0_2px_12px_rgba(0,0,0,0.5)]'
          />
        ) : (
          title && (
            <h2 className='mt-3 line-clamp-2 wrap-anywhere text-[clamp(1.75rem,3.6vw,3rem)] font-semibold leading-tight tracking-tight text-white'>
              {title}
            </h2>
          )
        )}
        {episodeLabel && (
          <p className='mt-5 text-sm font-medium leading-5 tracking-normal text-white/75'>
            {episodeLabel}
          </p>
        )}
        {episodeTitle && (
          <h3 className='mt-1 line-clamp-2 wrap-anywhere text-xl font-semibold leading-snug text-white'>
            {episodeTitle}
          </h3>
        )}
        {overview && (
          <p className='mt-4 line-clamp-3 max-w-xl wrap-anywhere text-[15px] leading-6 text-white/80'>
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

// Only healthy paused playback shows this; segment/EOF actions use the toolbar.
export const PlayerPauseResumeButton = memo(function PlayerPauseResumeButton({
  visible,
  onResume,
}: PlayerPauseResumeButtonProps) {
  const keymap = usePlayerKeymap();
  return (
    <div
      aria-hidden={!visible}
      className='pointer-events-none absolute inset-0 z-45 flex items-center justify-center'
    >
      <button
        type='button'
        aria-label='Resume playback'
        aria-keyshortcuts={ariaKeyShortcuts(keymap, 'togglePlay')}
        title={withShortcutHint('Resume playback', keymap, 'togglePlay')}
        tabIndex={visible ? 0 : -1}
        onClick={(e) => {
          e.stopPropagation();
          void onResume().catch(() => undefined);
        }}
        className={cn(
          'flex h-20 w-20 items-center justify-center rounded-full bg-transparent text-white/90 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60',
          'transition-opacity duration-150 ease-out motion-reduce:transition-none motion-reduce:animate-none',
          visible
            ? 'pointer-events-auto opacity-100 animate-in fade-in duration-150 fill-mode-backwards [animation-delay:150ms]'
            : 'pointer-events-none opacity-0',
        )}
      >
        <Play
          className='ml-1 h-12 w-12 fill-current drop-shadow-[0_2px_12px_rgba(0,0,0,0.6)]'
          strokeWidth={1.5}
        />
      </button>
    </div>
  );
});

interface PlayerUpNextCardProps {
  episode: Episode;
  thumbnail?: string;
  /** Null snapshots keep the card manual-only. */
  autoPlayCountdown: SubscribableStore<number | null>;
  autoPlayDurationSeconds: number;
  onCancelAutoPlay: () => void;
  onPlayNext: () => void;
}

const UP_NEXT_RING_RADIUS = 13;
const UP_NEXT_RING_CIRCUMFERENCE = 2 * Math.PI * UP_NEXT_RING_RADIUS;

// EOF "Up Next": one click (or the next-episode key) runs the silent auto-resolve. With auto-play on, a countdown ring arms the
// same action; the cancel chip disarms it.
export const PlayerUpNextCard = memo(function PlayerUpNextCard({
  episode,
  thumbnail,
  autoPlayCountdown,
  autoPlayDurationSeconds,
  onCancelAutoPlay,
  onPlayNext,
}: PlayerUpNextCardProps) {
  const playNextButtonRef = useRef<HTMLButtonElement | null>(null);
  const cancelButtonRef = (button: HTMLButtonElement | null) => {
    if (!button) return;
    return () => {
      if (document.activeElement === button) playNextButtonRef.current?.focus();
    };
  };
  const autoPlaySecondsLeft = useSyncExternalStore(
    autoPlayCountdown.subscribe,
    autoPlayCountdown.getSnapshot,
  );
  const keymap = usePlayerKeymap();
  const nextEpisodeKey = keymap.keys.nextEpisode[0];
  const countingDown = autoPlaySecondsLeft !== null;
  const ringProgress = countingDown
    ? clamp(autoPlaySecondsLeft / autoPlayDurationSeconds, 0, 1)
    : 0;
  return (
    <div data-player-interactive className={cn(EOF_CARD_SLOT_CLASS, 'gap-2')}>
      <button
        ref={playNextButtonRef}
        type='button'
        aria-keyshortcuts={ariaKeyShortcuts(keymap, 'nextEpisode')}
        onClick={(e) => {
          e.stopPropagation();
          onPlayNext();
        }}
        className={cn(
          EOF_GLASS_CLASS,
          'group/upnext flex min-w-0 max-w-md items-center gap-3 rounded-2xl p-3 text-left transition-colors hover:bg-zinc-900/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40',
        )}
      >
        {thumbnail && <EofCardThumbnail src={thumbnail} />}
        <div className='min-w-0'>
          <p className={EOF_EYEBROW_CLASS}>Up Next</p>
          <p className='mt-1 truncate text-sm font-semibold leading-snug text-white'>
            {formatEpisodeHeading(episode.season, episode.episode, episode.title)}
          </p>
          <p className='mt-1 text-xs leading-snug text-white/65'>
            {countingDown ? (
              <>
                Playing in <span aria-hidden='true'>{autoPlaySecondsLeft}s</span>
                <span className='sr-only'>
                  —{' '}
                  {nextEpisodeKey !== undefined
                    ? `press ${formatBindingKey(nextEpisodeKey)} or `
                    : ''}
                  click to play now
                </span>
              </>
            ) : (
              'Play next episode'
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
          ref={cancelButtonRef}
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
  /** 'card' floats above the expanded chrome (the Up Next slot); 'strip' docks inside the mini video surface. */
  variant?: 'card' | 'strip';
  onReplay: () => void;
  onBackToTitle: () => void;
}

// EOF without a next episode (movies, finales): replay or head back instead of idling on a frozen last frame.
// The mini strip keeps it visible under hover — docked chrome has no replay control of its own.
export const PlayerEndCard = memo(function PlayerEndCard({
  title,
  thumbnail,
  variant,
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
          className='flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-lg border border-white/15 bg-black/80 px-3 py-2 text-left transition-colors duration-200 hover:bg-black/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60'
        >
          {thumbnail && (
            <RemoteImage
              src={thumbnail}
              alt=''
              className='h-7 w-12 shrink-0 rounded object-cover'
            />
          )}
          <span className='min-w-0 flex-1 truncate text-xs font-medium text-white'>
            Watch again
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
          className='flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white/15 bg-black/80 text-white/80 transition-colors duration-200 hover:bg-black/90 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60'
        >
          <ArrowLeft className='h-3.5 w-3.5' />
        </button>
      </div>
    );
  }

  return (
    <div
      data-player-interactive
      className={cn(EOF_CARD_SLOT_CLASS, EOF_GLASS_CLASS, 'w-[420px] gap-3 rounded-2xl p-4')}
    >
      {thumbnail && <EofCardThumbnail src={thumbnail} />}
      <div className='min-w-0 flex-1'>
        <p className={EOF_EYEBROW_CLASS}>Playback finished</p>
        <p
          className='mt-1.5 line-clamp-2 text-sm font-semibold leading-snug text-white'
          title={title}
        >
          {title}
        </p>
        <div className='mt-3 flex flex-wrap items-center gap-2'>
          <button
            type='button'
            onClick={(e) => {
              e.stopPropagation();
              onReplay();
            }}
            className='flex min-h-9 items-center gap-2 rounded-lg bg-white px-3 py-2 text-xs font-semibold text-black transition-colors hover:bg-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950'
          >
            <RotateCcw className='h-3.5 w-3.5' />
            Watch again
          </button>
          <button
            type='button'
            onClick={(e) => {
              e.stopPropagation();
              onBackToTitle();
            }}
            className='min-h-9 rounded-lg px-3 py-2 text-xs font-medium text-white/75 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50'
          >
            Back to title
          </button>
        </div>
      </div>
    </div>
  );
});
