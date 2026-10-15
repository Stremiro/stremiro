import { Plus, RotateCcw } from 'lucide-react';
import { type KeyboardEvent, useState } from 'react';
import { ShortcutTable } from '@/components/shortcut-table';
import { Button } from '@/components/ui/button';
import { useAppUiPreferences } from '@/hooks/use-app-ui-preferences';
import {
  bindPlayerKey,
  FIXED_PLAYER_SHORTCUTS,
  formatBindingKey,
  MAX_KEYS_PER_PLAYER_ACTION,
  normalizeBindingKey,
  PLAYER_ACTIONS,
  type PlayerActionId,
  type PlayerKeymap,
  resolvePlayerKeymap,
} from '@/lib/player-keybindings';
import { BROWSE_SHORTCUTS, CALENDAR_SHORTCUTS } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';
import {
  SETTINGS_OUTLINE_BUTTON_CLASS,
  SettingsBody,
  SettingsGroup,
  SettingsGroupHeader,
  SettingsQueryError,
} from './chrome';

const SLOT_IDS = ['primary', 'secondary'] as const;
const MODIFIER_KEYS = new Set(['shift', 'control', 'alt', 'altgraph', 'meta', 'os']);

const KEY_SLOT_CLASS =
  'inline-flex h-7 min-w-[1.85rem] cursor-pointer items-center justify-center rounded-md border px-2 font-mono text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent-nav)/45 disabled:cursor-not-allowed disabled:opacity-50';

interface Capture {
  action: PlayerActionId;
  slot: number;
}

export function ShortcutsSection() {
  const {
    preferences: overrides,
    isHydrating,
    preferencesQuery,
    updatePreferences,
  } = useAppUiPreferences((preferences) => preferences.playerKeybindings);
  const keymap = resolvePlayerKeymap(overrides);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const hasOverrides = Object.keys(overrides).length > 0;

  const save = (next: Record<string, string[]>) => updatePreferences({ playerKeybindings: next });

  const startCapture = (next: Capture) => {
    setNotice(null);
    setCapture(next);
  };

  const handleCaptureKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!capture || event.nativeEvent.isComposing) return;
    const raw = event.key.toLowerCase();
    // Tab keeps moving focus (blur ends the capture); bare modifiers wait for the real key.
    if (raw === 'tab' || MODIFIER_KEYS.has(raw)) return;
    // Claim the key so browse hotkeys (Esc/Backspace = Back) don't also fire.
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    const label = PLAYER_ACTIONS.find((action) => action.id === capture.action)?.label ?? '';

    if (raw === 'escape') {
      setCapture(null);
      return;
    }
    if (raw === 'backspace' || raw === 'delete') {
      if (capture.slot < keymap.keys[capture.action].length) {
        save(bindPlayerKey(keymap, capture.action, capture.slot, null));
        setNotice(`Removed a key from ${label}.`);
      }
      setCapture(null);
      return;
    }
    if (event.ctrlKey || event.altKey || event.metaKey) {
      setNotice('Ctrl, Alt and Win combinations can’t be used in the player.');
      return;
    }
    const key = normalizeBindingKey(event.key);
    if (key === null) {
      setNotice(
        /^[0-9]$/.test(event.key)
          ? 'Number keys are reserved for seeking to a percentage.'
          : `${formatBindingKey(raw)} can’t be assigned.`,
      );
      return;
    }
    const previousOwner = keymap.byKey.get(key);
    save(bindPlayerKey(keymap, capture.action, capture.slot, key));
    setCapture(null);
    setNotice(
      previousOwner && previousOwner !== capture.action
        ? `${formatBindingKey(key)} moved from ${PLAYER_ACTIONS.find((action) => action.id === previousOwner)?.label} to ${label}.`
        : null,
    );
  };

  return (
    <div className='space-y-5'>
      <SettingsQueryError query={preferencesQuery} message="Couldn't load your shortcuts." />
      <SettingsGroup>
        <SettingsGroupHeader
          title='Player shortcuts'
          description={`Click a key to change it — up to ${MAX_KEYS_PER_PLAYER_ACTION} per action. While listening, Esc cancels and Backspace removes the key.`}
          action={
            <Button
              size='sm'
              variant='outline'
              disabled={isHydrating || !hasOverrides}
              onClick={() => {
                setCapture(null);
                setNotice('All player shortcuts restored to their defaults.');
                save({});
              }}
              className={cn('h-9 gap-2 px-3.5 text-[13px]', SETTINGS_OUTLINE_BUTTON_CLASS)}
            >
              <RotateCcw className='h-3.5 w-3.5' />
              Reset all
            </Button>
          }
        />
        <p
          aria-live='polite'
          className={cn(
            'border-b border-white/[0.06] px-5 text-[12.5px] text-zinc-300',
            notice ? 'py-2.5' : 'hidden',
          )}
        >
          {notice}
        </p>
        <ul className='divide-y divide-white/[0.06] px-5 py-1'>
          {PLAYER_ACTIONS.map((action) => (
            <PlayerBindingRow
              key={action.id}
              action={action.id}
              label={action.label}
              keymap={keymap}
              capture={capture}
              disabled={isHydrating}
              onStartCapture={startCapture}
              onCaptureKey={handleCaptureKey}
              onCancelCapture={() => setCapture(null)}
              onReset={() => {
                setCapture(null);
                setNotice(null);
                const next = { ...keymap.overrides };
                delete next[action.id];
                save(next);
              }}
            />
          ))}
        </ul>
        <SettingsBody className='border-t border-white/[0.06]'>
          <p className='mb-3 text-[11px] font-medium uppercase tracking-[0.08em] text-zinc-400'>
            Always available
          </p>
          <ShortcutTable shortcuts={FIXED_PLAYER_SHORTCUTS} />
        </SettingsBody>
      </SettingsGroup>
      <SettingsGroup>
        <SettingsGroupHeader
          title='Browse shortcuts'
          description='Active on every page outside the player.'
        />
        <SettingsBody>
          <ShortcutTable shortcuts={BROWSE_SHORTCUTS} />
        </SettingsBody>
      </SettingsGroup>
      <SettingsGroup>
        <SettingsGroupHeader
          title='Calendar shortcuts'
          description='Active on the Calendar page.'
        />
        <SettingsBody>
          <ShortcutTable shortcuts={CALENDAR_SHORTCUTS} />
        </SettingsBody>
      </SettingsGroup>
    </div>
  );
}

function PlayerBindingRow({
  action,
  label,
  keymap,
  capture,
  disabled,
  onStartCapture,
  onCaptureKey,
  onCancelCapture,
  onReset,
}: {
  action: PlayerActionId;
  label: string;
  keymap: PlayerKeymap;
  capture: Capture | null;
  disabled: boolean;
  onStartCapture: (capture: Capture) => void;
  onCaptureKey: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onCancelCapture: () => void;
  onReset: () => void;
}) {
  const keys = keymap.keys[action];
  const customized = keymap.overrides[action] !== undefined;
  const visibleSlots = SLOT_IDS.slice(0, Math.min(keys.length + 1, MAX_KEYS_PER_PLAYER_ACTION));

  return (
    <li className='flex min-h-12 items-center justify-between gap-4 py-3'>
      <span className='flex min-w-0 items-center gap-2 text-[14px] font-medium text-zinc-100'>
        <span className='truncate'>{label}</span>
        {customized ? (
          <span className='shrink-0 text-[11.5px] font-normal text-(--accent-nav)'>Custom</span>
        ) : null}
        {keys.length === 0 ? (
          <span className='shrink-0 text-[12px] font-normal text-zinc-500'>Unassigned</span>
        ) : null}
      </span>
      <div className='flex shrink-0 items-center gap-1.5'>
        {visibleSlots.map((slotId, slot) => {
          const key = keys[slot] ?? null;
          const listening = capture?.action === action && capture.slot === slot;
          const keyLabel = key === null ? null : formatBindingKey(key);
          return (
            <button
              // Stable per-slot identity: rebinding keeps focus on the same button.
              key={slotId}
              type='button'
              disabled={disabled}
              data-key-capture={listening ? '' : undefined}
              aria-label={
                listening
                  ? `Press a key for ${label}`
                  : keyLabel
                    ? `${label}: ${keyLabel}. Change key`
                    : `Add a key for ${label}`
              }
              onClick={() => (listening ? onCancelCapture() : onStartCapture({ action, slot }))}
              onKeyDown={listening ? onCaptureKey : undefined}
              onBlur={listening ? onCancelCapture : undefined}
              className={cn(
                KEY_SLOT_CLASS,
                listening
                  ? 'border-(--accent-nav)/60 bg-(--accent-nav)/10 text-white'
                  : key === null
                    ? 'border-dashed border-white/[0.1] text-zinc-500 hover:border-white/20 hover:text-zinc-300'
                    : 'border-white/[0.08] bg-white/[0.04] text-zinc-200 hover:border-white/20 hover:bg-white/[0.08]',
              )}
            >
              {listening ? (
                <span className='animate-pulse font-sans'>Press a key…</span>
              ) : keyLabel ? (
                keyLabel
              ) : (
                <Plus aria-hidden='true' className='h-3 w-3' />
              )}
            </button>
          );
        })}
        <button
          type='button'
          aria-label={`Reset ${label} to default`}
          title='Reset to default'
          disabled={disabled || !customized}
          onClick={onReset}
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent-nav)/45',
            !customized && 'invisible',
          )}
        >
          <RotateCcw aria-hidden='true' className='h-3.5 w-3.5' />
        </button>
      </div>
    </li>
  );
}
