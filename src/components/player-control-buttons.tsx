import { Pause, Play, RotateCcw, SkipBack, SkipForward } from 'lucide-react';
import {
  memo,
  type MouseEventHandler,
  type ReactNode,
  useState,
  type WheelEventHandler,
} from 'react';
import {
  CHROME_ICON_BUTTON_CLASS,
  CHROME_ICON_CLASS,
  CHROME_ICON_STROKE,
  CHROME_PILL_CLASS,
  CHROME_VALUE_BUBBLE_CLASS,
} from '@/components/player-chrome-styles';
import { PlayerSlider } from '@/components/player-slider';
import { PlayerVolumeIcon } from '@/components/player-volume-icon';
import {
  ariaKeyShortcuts,
  type PlayerActionId,
  type PlayerKeymap,
  withShortcutHint,
} from '@/lib/player-keybindings';
import { cn } from '@/lib/utils';

export const MINI_ICON_BUTTON_CLASS =
  'flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-white/90 transition-colors hover:bg-white/15 hover:text-white active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/60 disabled:opacity-35 disabled:pointer-events-none motion-reduce:transition-none motion-reduce:active:scale-100';

type PlayerControlVariant = 'full' | 'pip' | 'mini';

const ICON_CLASS = {
  full: CHROME_ICON_CLASS,
  pip: 'h-4 w-4',
  mini: 'h-4 w-4',
};

interface PlayerButtonProps {
  variant: PlayerControlVariant;
  keymap: PlayerKeymap;
  label: string;
  title?: string;
  disabled?: boolean;
  onClick: MouseEventHandler<HTMLButtonElement>;
}

function PlayerControlButton({
  variant,
  keymap,
  label,
  title,
  action,
  className,
  ...props
}: PlayerButtonProps & {
  action?: PlayerActionId;
  className?: string;
  children: ReactNode;
  onWheel?: WheelEventHandler<HTMLButtonElement>;
}) {
  return (
    <button
      type='button'
      aria-label={label}
      aria-keyshortcuts={action && ariaKeyShortcuts(keymap, action)}
      title={title ?? (action ? withShortcutHint(label, keymap, action) : label)}
      className={cn(
        variant === 'mini' ? MINI_ICON_BUTTON_CLASS : CHROME_ICON_BUTTON_CLASS,
        className,
      )}
      {...props}
    />
  );
}

export function PlayerPlayButton({
  variant,
  icon,
  ...props
}: PlayerButtonProps & { icon: 'play' | 'pause' | 'replay' }) {
  const Icon = icon === 'replay' ? RotateCcw : icon === 'pause' ? Pause : Play;
  return (
    <PlayerControlButton
      variant={variant}
      action='togglePlay'
      className={
        variant === 'pip'
          ? 'bg-white/10 text-white hover:bg-white/20'
          : variant === 'mini'
            ? 'h-9 w-9 rounded-lg bg-(--accent-act) text-(--on-accent-act) hover:bg-(--accent-act)/90'
            : 'bg-(--accent-act) text-(--on-accent-act) hover:bg-(--accent-act)/90 [&_svg]:drop-shadow-none'
      }
      {...props}
    >
      <Icon
        aria-hidden='true'
        className={cn(
          ICON_CLASS[variant],
          icon !== 'replay' && 'fill-current',
          variant === 'full' && icon !== 'replay' && 'h-6 w-6',
          variant === 'mini' && icon === 'play' && 'ml-px',
        )}
        strokeWidth={CHROME_ICON_STROKE}
      />
    </PlayerControlButton>
  );
}

export function PlayerMuteButton({
  variant,
  muted,
  volume,
  ...props
}: PlayerButtonProps & {
  muted: boolean;
  volume: number;
  onWheel?: WheelEventHandler<HTMLButtonElement>;
}) {
  return (
    <PlayerControlButton variant={variant} action='toggleMute' {...props}>
      <PlayerVolumeIcon
        muted={muted}
        volume={volume}
        className={ICON_CLASS[variant]}
        strokeWidth={CHROME_ICON_STROKE}
      />
    </PlayerControlButton>
  );
}

export function PlayerPreviousButton({ variant, ...props }: PlayerButtonProps) {
  return (
    <PlayerControlButton variant={variant} action='previousEpisode' {...props}>
      <SkipBack
        aria-hidden='true'
        className={ICON_CLASS[variant]}
        strokeWidth={CHROME_ICON_STROKE}
      />
    </PlayerControlButton>
  );
}

export function PlayerNextButton({ variant, ...props }: PlayerButtonProps) {
  return (
    <PlayerControlButton variant={variant} action='nextEpisode' {...props}>
      <SkipForward
        aria-hidden='true'
        className={ICON_CLASS[variant]}
        strokeWidth={CHROME_ICON_STROKE}
      />
    </PlayerControlButton>
  );
}

interface PlayerVolumeControlProps {
  variant: 'full' | 'mini';
  active: boolean;
  keymap: PlayerKeymap;
  volume: number;
  isMuted: boolean;
  onToggleMute: () => void | Promise<void>;
  onVolumeChange: (value: number) => void | Promise<void>;
  onVolumeWheel?: (event: Pick<WheelEvent, 'deltaY' | 'deltaMode'>) => Promise<void>;
}

export const PlayerVolumeControl = memo(function PlayerVolumeControl({
  variant,
  active,
  keymap,
  volume,
  isMuted,
  onToggleMute,
  onVolumeChange,
  onVolumeWheel,
}: PlayerVolumeControlProps) {
  const [aimedVolume, setAimedVolume] = useState<number | null>(null);
  const muted = isMuted || volume === 0;
  const displayedVolume = isMuted ? 0 : Math.round(volume);
  const preview = active ? (aimedVolume ?? displayedVolume) : displayedVolume;
  const full = variant === 'full';
  return (
    <div
      data-player-interactive
      className={cn(
        'flex shrink-0 items-center gap-2',
        full ? cn(CHROME_PILL_CLASS, 'gap-1.5 pr-3') : 'ml-auto',
      )}
      onWheel={
        onVolumeWheel
          ? (event) => {
              if (event.deltaY === 0) return;
              event.stopPropagation();
              void onVolumeWheel(event).catch(() => undefined);
            }
          : undefined
      }
    >
      <PlayerMuteButton
        variant={variant}
        keymap={keymap}
        label={muted ? 'Unmute' : 'Mute'}
        muted={muted}
        volume={volume}
        onClick={() => void Promise.resolve(onToggleMute()).catch(() => undefined)}
      />
      <div className={cn('relative group/volume shrink-0', full ? 'w-20' : 'w-16')}>
        {full && (
          <span
            aria-hidden='true'
            className={cn(
              CHROME_VALUE_BUBBLE_CLASS,
              'pointer-events-none absolute bottom-full mb-2 -translate-x-1/2 opacity-0 transition-opacity group-hover/volume:opacity-100 group-has-[[data-keyboard-focus]]/volume:opacity-100 group-has-[:active]/volume:opacity-100 motion-reduce:transition-none',
            )}
            style={{ left: `${preview}%` }}
          >
            {preview}%
          </span>
        )}
        <PlayerSlider
          variant='bar'
          active={active}
          value={[isMuted ? 0 : volume]}
          max={100}
          step={1}
          aria-label='Volume'
          aria-valuetext={isMuted ? 'Muted' : `${displayedVolume}%`}
          title={isMuted ? 'Volume: muted' : `Volume: ${displayedVolume}%`}
          onAimChange={setAimedVolume}
          onValueChange={(value) =>
            void Promise.resolve(onVolumeChange(value[0] ?? 0)).catch(() => undefined)
          }
          onKeyDown={(event) => {
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') event.stopPropagation();
          }}
          className={full ? 'w-20' : 'h-8 w-16'}
        />
      </div>
      {!full && (
        <span
          aria-hidden='true'
          className='w-9 text-right text-xs font-medium tabular-nums text-white'
        >
          {preview}%
        </span>
      )}
    </div>
  );
});
