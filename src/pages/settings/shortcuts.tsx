import { Keyboard, Lock, Plus, RotateCcw } from 'lucide-react';
import { type KeyboardEvent, useRef, useState } from 'react';
import { toast } from 'sonner';
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
  PLAYER_ACTION_GROUPS,
  PLAYER_ACTIONS,
  type PlayerActionId,
  type PlayerKeymap,
} from '@/lib/player-keybindings';
import { BROWSE_SHORTCUTS, CALENDAR_SHORTCUTS } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';
import {
  SETTINGS_CAPTION_CLASS,
  SETTINGS_OUTLINE_BUTTON_CLASS,
  SettingsBody,
  SettingsGroup,
  SettingsGroupHeader,
  SettingsQueryError,
} from './chrome';

const SLOT_IDS = ['primary', 'secondary'] as const;
const MODIFIER_KEYS = new Set(['shift', 'control', 'alt', 'altgraph', 'meta', 'os']);

const KEY_SLOT_CLASS =
  'inline-flex h-6 min-w-6 cursor-pointer items-center justify-center whitespace-nowrap rounded-[5px] border px-1.5 font-mono text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent-nav)/45 disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50';
const SHORTCUT_CAPTION_CLASS = `mb-1.5 ${SETTINGS_CAPTION_CLASS}`;
export const FIXED_SHORTCUT_SECTIONS = [
  ['Player', FIXED_PLAYER_SHORTCUTS],
  ['Browsing', BROWSE_SHORTCUTS],
  ['Calendar', CALENDAR_SHORTCUTS],
] as const;

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

  const handleResetAll = () => {
    if (isSaving || !hasOverrides) return;
    cancelCapture();
    const previous = preferences.playerKeybindings;
    void save({}).then((saved) => {
      if (!saved) return;
      let undoUsed = false;
      toast.success('Player shortcuts reset to defaults.', {
        duration: 6000,
        action: {
          label: 'Undo',
          onClick: () => {
            if (undoUsed) return;
            undoUsed = true;
            cancelCapture();
            void save(previous).then((restored) => {
              if (restored) toast.success('Player shortcuts restored');
            });
          },
        },
      });
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
    <div className='space-y-4'>
      <SettingsQueryError query={preferencesQuery} message="Couldn't load your shortcuts." />
      <SettingsGroup id='setting-player-shortcuts'>
        <SettingsGroupHeader
          icon={Keyboard}
          title='Player shortcuts'
          description={`Click a key to rebind it, up to ${MAX_KEYS_PER_PLAYER_ACTION} per action. Esc cancels, Backspace removes.`}
          action={
            <Button
              size='sm'
              variant='outline'
              disabled={isHydrating}
              aria-disabled={isSaving || !hasOverrides || undefined}
              onClick={handleResetAll}
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
            'border-b border-white/[0.06] px-4 sm:px-5 text-[12.5px] text-zinc-300',
            notice ? 'py-2.5' : 'hidden',
          )}
        >
          {notice}
        </p>
        <SettingsBody className='@container/shortcuts'>
          <div className='grid items-start gap-6 @min-[42rem]/shortcuts:grid-cols-2 @min-[64rem]/shortcuts:grid-cols-3'>
            {PLAYER_ACTION_GROUPS.map((group) => (
              <section key={group} aria-label={group} className='min-w-0'>
                <h3 className={SHORTCUT_CAPTION_CLASS}>{group}</h3>
                <ul className='divide-y divide-white/[0.06]'>
                  {PLAYER_ACTIONS.filter((action) => action.group === group).map((action) => (
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
              </section>
            ))}
          </div>
        </SettingsBody>
      </SettingsGroup>
      <SettingsGroup>
        <SettingsGroupHeader
          icon={Lock}
          title='Fixed shortcuts'
          description='Built-in player, browsing and Calendar shortcuts. These cannot be reassigned.'
        />
        <SettingsBody className='@container/shortcuts'>
          <div className='grid items-start gap-6 @min-[42rem]/shortcuts:grid-cols-2 @min-[64rem]/shortcuts:grid-cols-3'>
            {FIXED_SHORTCUT_SECTIONS.map(([title, shortcuts]) => (
              <section key={title} aria-label={title} className='min-w-0'>
                <h3 className={SHORTCUT_CAPTION_CLASS}>{title}</h3>
                <ShortcutTable
                  shortcuts={shortcuts}
                  idPrefix={`setting-fixed-${title}`}
                  className='grid-cols-1 divide-y divide-white/[0.06] @xl:grid-cols-1 [&>div]:h-auto [&>div]:min-h-9 [&>div]:py-1.5 [&_dt]:whitespace-normal [&_dt]:overflow-visible [&_dd]:max-w-[60%] [&_dd]:flex-wrap [&_dd]:justify-end'
                />
              </section>
            ))}
          </div>
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
  const primarySlotRef = useRef<HTMLButtonElement>(null);
  const keys = keymap.keys[action];
  const customized = keymap.overrides[action] !== undefined;
  const visibleSlots = SLOT_IDS.slice(0, Math.min(keys.length + 1, MAX_KEYS_PER_PLAYER_ACTION));

  return (
    <li
      id={`setting-shortcut-${action}`}
      className='flex min-h-10 items-center justify-between gap-3 py-2'
    >
      <span className='flex min-w-0 flex-1 items-center gap-2 text-[13px] leading-snug text-zinc-200'>
        <span>{label}</span>
        {customized ? (
          <span title='Customized' className='h-1.5 w-1.5 shrink-0 rounded-full bg-(--accent-nav)'>
            <span className='sr-only'>Customized</span>
          </span>
        ) : null}
      </span>
      <div className='flex max-w-[65%] shrink-0 flex-wrap items-center justify-end gap-1'>
        {visibleSlots.map((slotId, slot) => {
          const key = keys[slot] ?? null;
          const listening = capture?.action === action && capture.slot === slot;
          const keyLabel = key === null ? null : formatBindingKey(key);
          return (
            <button
              // Stable per-slot identity: rebinding keeps focus on the same button.
              key={slotId}
              ref={slot === 0 ? primarySlotRef : undefined}
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
                <span className='animate-pulse font-sans motion-reduce:animate-none'>
                  Press a key
                </span>
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
            if (isSaving) return;
            primarySlotRef.current?.focus({ preventScroll: true });
            onReset();
          }}
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded-[5px] text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent-nav)/45 aria-disabled:pointer-events-none',
            !customized && 'invisible',
          )}
        >
          <RotateCcw aria-hidden='true' className='h-3.5 w-3.5' />
        </button>
      </div>
    </li>
  );
}
