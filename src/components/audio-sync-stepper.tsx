import { Minus, Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import type { AppUiPreferencesPatch } from '@/lib/api';
import { clamp } from '@/lib/utils';

const AUDIO_DELAY_MIN = -5;
const AUDIO_DELAY_MAX = 5;

function nudgeAudioDelay(audioDelay: number, delta: number) {
  return Math.round(clamp(audioDelay + delta, AUDIO_DELAY_MIN, AUDIO_DELAY_MAX) * 10) / 10;
}

interface StepButtonProps {
  className: string;
  label: string;
  title?: string;
  disabled: boolean;
  onStep: () => void;
  children: ReactNode;
}

export function StepButton({
  className,
  label,
  title,
  disabled,
  onStep,
  children,
}: StepButtonProps) {
  return (
    <button
      type='button'
      aria-label={label}
      title={title}
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (!disabled) onStep();
      }}
      className={className}
    >
      {children}
    </button>
  );
}

interface AudioSyncStepperProps {
  audioDelay: number;
  isHydrating: boolean;
  updatePreferences: (patch: AppUiPreferencesPatch) => void;
  buttonClassName: string;
  resetClassName: string;
  outputClassName: string;
  resetContent: ReactNode;
  resetTitle?: string;
  live?: boolean;
}

export function AudioSyncStepper({
  audioDelay,
  isHydrating,
  updatePreferences,
  buttonClassName,
  resetClassName,
  outputClassName,
  resetContent,
  resetTitle,
  live,
}: AudioSyncStepperProps) {
  return (
    <>
      <StepButton
        className={buttonClassName}
        label='Play audio 0.1 seconds earlier'
        disabled={isHydrating || audioDelay <= AUDIO_DELAY_MIN}
        onStep={() => updatePreferences({ audioDelay: nudgeAudioDelay(audioDelay, -0.1) })}
      >
        <Minus aria-hidden='true' className='size-3.5' />
      </StepButton>
      <output className={outputClassName} aria-live={live ? 'polite' : undefined}>
        {audioDelay > 0 ? '+' : ''}
        {audioDelay.toFixed(1)}s
      </output>
      <StepButton
        className={buttonClassName}
        label='Play audio 0.1 seconds later'
        disabled={isHydrating || audioDelay >= AUDIO_DELAY_MAX}
        onStep={() => updatePreferences({ audioDelay: nudgeAudioDelay(audioDelay, 0.1) })}
      >
        <Plus aria-hidden='true' className='size-3.5' />
      </StepButton>
      <StepButton
        className={resetClassName}
        label='Reset audio sync'
        title={resetTitle}
        disabled={isHydrating || audioDelay === 0}
        onStep={() => updatePreferences({ audioDelay: 0 })}
      >
        {resetContent}
      </StepButton>
    </>
  );
}
