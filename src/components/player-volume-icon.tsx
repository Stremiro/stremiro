import { Volume1, Volume2, VolumeX } from 'lucide-react';

interface PlayerVolumeIconProps {
  /** True when the channel is silent — a muted flag or a zeroed level. */
  muted: boolean;
  /** 0–100 loudness; picks the half/full glyph while unmuted. */
  volume: number;
  className?: string;
  strokeWidth?: number;
}

/** One loudness ladder for every surface — expanded chrome, mini player, and
    the OSD can't drift on which glyph muted/quiet/loud shows. */
export function PlayerVolumeIcon({ muted, volume, className, strokeWidth }: PlayerVolumeIconProps) {
  const Icon = muted ? VolumeX : volume < 50 ? Volume1 : Volume2;
  return <Icon className={className} strokeWidth={strokeWidth} />;
}
