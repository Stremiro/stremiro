import type { SkipSegment } from '@/lib/api';

export const SKIP_SEGMENT_LABELS: Record<SkipSegment['type'], string> = {
  intro: 'Intro',
  recap: 'Recap',
  outro: 'Outro',
  preview: 'Preview',
};

export function isNearMediaEnd(position: number, duration: number): boolean {
  return duration > 0 && position >= Math.max(0, duration - 1);
}
