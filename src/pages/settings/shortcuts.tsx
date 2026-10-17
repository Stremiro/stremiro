import { Plus, RotateCcw } from 'lucide-react';
import { type KeyboardEvent, useRef, useState } from 'react';
import { ShortcutTable } from '@/components/shortcut-table';
import { Button } from '@/components/ui/button';
import { useAppUiPreferences } from '@/hooks/use-app-ui-preferences';
import { useMountedRef } from '@/hooks/use-mounted-ref';
import { api, getErrorMessage } from '@/lib/api';
import {
  createPlayerKeymap,
  FIXED_PLAYER_SHORTCUTS,
  formatBindingKey,
  MAX_KEYS_PER_PLAYER_ACTION,
  PLAYER_ACTIONS,
  type PlayerActionId,
  type PlayerKeymap,
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
  'inline-flex h-7 min-w-[1.85rem] cursor-pointer items-center justify-center rounded-md border px-2 font-mono text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent-nav)/45 disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50';

interface Capture {
  action: PlayerActionId;
  slot: number;
}

export function ShortcutsSection() {
  const { preferences, isHydrating, preferencesQuery, savePreferences } = useAppUiPreferences();
  const keymap = createPlayerKeymap(
    preferences.effectivePlayerKeybindings,
    preferences.playerKeybindings,
  );
  const [isSaving, setIsSaving] = useState(false);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const captureSequence = useRef(0);
  const mountedRef = useMountedRef();
  const hasOverrides = Object.keys(preferences.playerKeybindings).length > 0;

  const save = (next: Record<string, string[]>): Promise<boolean> => {
    setNotice(null);
    setIsSaving(true);
    return savePreferences({ playerKeybindings: next })
      .then(
        () => true,
        () => false,
      )
      .finally(() => {
        if (mountedRef.current) setIsSaving(false);
      });
  };

  const startCapture = (next: Capture) => {
    if (isHydrating || isSaving) return;
    captureSequence.current += 1;
    setNotice(null);
    setCapture(next);
  };

  const cancelCapture = () => {
    captureSequence.current += 1;
    setCapture(null);
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
    const sequence = ++captureSequence.current;
    const label = PLAYER_ACTIONS.find((action) => action.id === capture.action)?.label ?? '';

    if (raw === 'escape') {
      cancelCapture();
      return;
    }
    const clearing = raw === 'backspace' || raw === 'delete';
    if (clearing && capture.slot >= keymap.keys[capture.action].length) {
      cancelCapture();
      return;
    }
    if (!clearing && (event.ctrlKey || event.altKey || event.metaKey)) {
      setNotice('Ctrl, Alt and Win combinations can’t be used in the player.');
      return;
    }
    void api
      .bindPlayerKeybinding(
        keymap.overrides,
        capture.action,
        capture.slot,
        clearing ? null : event.key,
      )
      .then(
        async (next) => {
          if (!mountedRef.current || sequence !== captureSequence.current) return;
          const previousOwner = keymap.byKey.get(raw);
          const saving = save(next);
          cancelCapture();
          const saveSequence = captureSequence.current;
          const saved = await saving;
          if (!saved || !mountedRef.current || saveSequence !== captureSequence.current) return;
          setNotice(
            clearing
              ? `Removed a key from ${label}.`
              : previousOwner && previousOwner !== capture.action
                ? `${formatBindingKey(raw)} moved from ${PLAYER_ACTIONS.find((action) => action.id === previousOwner)?.label} to ${label}.`
                : null,
          );
        },
        (error: unknown) => {
          if (!mountedRef.current || sequence !== captureSequence.current) return;
          setNotice(getErrorMessage(error));
        },
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
              disabled={isHydrating}
              aria-disabled={isSaving || !hasOverrides || undefined}
              onClick={() => {
                if (isSaving || !hasOverrides) return;
                cancelCapture();
                void save({}).then((saved) => {
                  if (saved && mountedRef.current) {
                    setNotice('All player shortcuts restored to their defaults.');
                  }
                });
              }}
              className={cn(
                'h-9 gap-2 px-3.5 text-[13px] aria-disabled:pointer-events-none aria-disabled:opacity-50',
                SETTINGS_OUTLINE_BUTTON_CLASS,
              )}
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
              isSaving={isSaving}
              onStartCapture={startCapture}
              onCaptureKey={handleCaptureKey}
              onCancelCapture={cancelCapture}
              onReset={() => {
                cancelCapture();
                const next = { ...keymap.overrides };
                delete next[action.id];
                void save(next);
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
  isSaving,
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
  isSaving: boolean;
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
              aria-disabled={isSaving || undefined}
              data-key-capture={listening ? '' : undefined}
              aria-label={
                listening
                  ? `Press a key for ${label}`
                  : keyLabel
                    ? `${label}: ${keyLabel}. Change key`
                    : `Add a key for ${label}`
              }
              onClick={() => {
                if (isSaving) return;
                if (listening) onCancelCapture();
                else onStartCapture({ action, slot });
              }}
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
          aria-disabled={isSaving || undefined}
          onClick={() => {
            if (!isSaving) onReset();
          }}
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent-nav)/45 aria-disabled:pointer-events-none',
            !customized && 'invisible',
          )}
        >
          <RotateCcw aria-hidden='true' className='h-3.5 w-3.5' />
        </button>
      </div>
    </li>
  );
}
