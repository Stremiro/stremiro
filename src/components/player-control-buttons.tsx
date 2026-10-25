import { Pause, Play, RotateCcw, SkipBack, SkipForward } from 'lucide-react';
import type { MouseEventHandler, ReactNode, WheelEventHandler } from 'react';
import {
  CHROME_ICON_BUTTON_CLASS,
  CHROME_ICON_CLASS,
  CHROME_ICON_STROKE,
} from '@/components/player-chrome-styles';
import { PlayerVolumeIcon } from '@/components/player-volume-icon';
import {
  ariaKeyShortcuts,
  type PlayerActionId,
  type PlayerKeymap,
  withShortcutHint,
} from '@/lib/player-keybindings';
import { cn } from '@/lib/utils';

export const MINI_ICON_BUTTON_CLASS =
  'flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-white/85 transition-colors hover:bg-white/15 hover:text-white active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/60 disabled:opacity-35 disabled:pointer-events-none motion-reduce:transition-none motion-reduce:active:scale-100';

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
            ? 'bg-white/10 text-white'
            : undefined
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
