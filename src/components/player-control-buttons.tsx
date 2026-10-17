import { Pause, Play, RotateCcw, SkipForward } from 'lucide-react';
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
  'flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-white/85 transition-colors hover:bg-white/15 hover:text-white active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/60';

type PlayerControlVariant = 'full' | 'pip' | 'mini';

const BUTTON_CLASS = {
  full: CHROME_ICON_BUTTON_CLASS,
  pip: cn(CHROME_ICON_BUTTON_CLASS, 'cursor-pointer'),
  mini: MINI_ICON_BUTTON_CLASS,
};

const ICON_CLASS = {
  full: CHROME_ICON_CLASS,
  pip: 'h-4 w-4',
  mini: 'h-[15px] w-[15px]',
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
  action: PlayerActionId;
  className?: string;
  children: ReactNode;
  onWheel?: WheelEventHandler<HTMLButtonElement>;
}) {
  return (
    <button
      type='button'
      aria-label={label}
      aria-keyshortcuts={ariaKeyShortcuts(keymap, action)}
      title={title ?? withShortcutHint(label, keymap, action)}
      className={cn(BUTTON_CLASS[variant], className)}
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
  const iconClass =
    icon === 'replay'
      ? 'h-4 w-4'
      : variant === 'full'
        ? 'h-6 w-6 fill-current'
        : variant === 'mini'
          ? icon === 'play'
            ? 'ml-px h-4 w-4 fill-white'
            : 'h-4 w-4 fill-white'
          : 'h-4 w-4 fill-current';
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
        className={iconClass}
        strokeWidth={variant === 'full' ? CHROME_ICON_STROKE : undefined}
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
        strokeWidth={variant === 'pip' ? undefined : CHROME_ICON_STROKE}
      />
    </PlayerControlButton>
  );
}

export function PlayerNextButton({ variant, ...props }: PlayerButtonProps) {
  return (
    <PlayerControlButton variant={variant} action='nextEpisode' {...props}>
      <SkipForward
        className={ICON_CLASS[variant]}
        strokeWidth={variant === 'pip' ? undefined : CHROME_ICON_STROKE}
      />
    </PlayerControlButton>
  );
}
