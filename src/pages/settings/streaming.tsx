import { closestCenter, DndContext, type DragEndEvent } from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { GripVertical, Loader2, Plus, Trash2 } from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { type AddonConfig, type AddonConfigInput, api, getErrorMessage } from '@/lib/api';
import {
  ADDON_CONFIGS_QUERY_KEY,
  invalidateDiscoveryQueries,
  invalidateStreamQueries,
} from '@/lib/query-invalidation';
import { useAddonConfigs } from '@/hooks/use-addon-configs';
import { useSortableSensors } from '@/hooks/use-sortable-sensors';
import { cn } from '@/lib/utils';
import {
  SETTINGS_OUTLINE_BUTTON_CLASS,
  SettingsBody,
  SettingsGroup,
  SettingsGroupHeader,
  SettingsSwitch,
} from './chrome';

// ── Helpers ──────────────────────────────────────────────────────────────────

// `crypto.randomUUID` is guaranteed in the Tauri/localhost secure context.
function generateId(): string {
  return `addon-${crypto.randomUUID()}`;
}

function deriveAddonNameFromUrl(url: string): string {
  try {
    return new URL(url).host || 'Custom Addon';
  } catch {
    return 'Custom Addon';
  }
}

function hasAsciiPrefixIgnoreCase(value: string, prefix: string): boolean {
  return value.length >= prefix.length && value.slice(0, prefix.length).toLowerCase() === prefix;
}

function rewriteStremioInstallReference(trimmed: string): string | null {
  if (!hasAsciiPrefixIgnoreCase(trimmed, 'stremio://')) {
    return trimmed.includes('://') ? trimmed : `https://${trimmed}`;
  }

  const rest = trimmed.slice('stremio://'.length);
  if (hasAsciiPrefixIgnoreCase(rest, 'https://') || hasAsciiPrefixIgnoreCase(rest, 'http://')) {
    return rest;
  }
  if (rest.includes('://')) return null;
  return `https://${rest}`;
}

function normalizeAddonUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const withScheme = rewriteStremioInstallReference(trimmed);
  if (!withScheme) return null;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  // Rust's save path drops embedded credentials; normalize the same way so
  // dedupe keys match what the backend actually stores. Order matches
  // `build_manifest_url`/`strip_manifest_suffix`: trailing slashes strip
  // BEFORE the manifest suffix so `…/manifest.json/` folds identically.
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  const normalizedPath = parsed.pathname.replace(/\/+$/, '').replace(/\/manifest\.json$/i, '');
  parsed.pathname = normalizedPath || '/';

  return parsed.toString().replace(/\/$/, '');
}

function isConfigureUrl(url: string): boolean {
  try {
    return /\/configure\/?$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

// ── Addon rows ───────────────────────────────────────────────────────────────

interface AddonRowProps {
  addon: AddonConfig;
  isWorking: boolean;
  /** Left-edge grip: sortable rows get a drag handle, pinned rows a muted grip. */
  handle: ReactNode;
  pinned?: boolean;
  onToggle: (id: string) => void;
  /** Only unpinned rows render a remove affordance. */
  onRemove?: (id: string) => void;
}

function AddonRow({ addon, handle, isWorking, pinned, onToggle, onRemove }: AddonRowProps) {
  return (
    <>
      {handle}
      <div className={cn('min-w-0 flex-1 transition-opacity', !addon.enabled && 'opacity-45')}>
        <div className='flex items-center gap-2'>
          <span className='truncate text-[13.5px] font-medium text-zinc-100'>{addon.name}</span>
          {pinned ? (
            <span className='shrink-0 rounded-md border border-white/10 bg-white/[0.06] px-1.5 py-px text-[9.5px] font-bold uppercase tracking-wider text-zinc-400'>
              Default
            </span>
          ) : null}
        </div>
        <p
          data-selectable='true'
          className='mt-1 truncate font-mono text-[11.5px] leading-none text-zinc-500'
        >
          {addon.displayUrl}
        </p>
      </div>

      <div className='flex shrink-0 items-center gap-1.5'>
        {!pinned && onRemove && (
          <button
            type='button'
            title='Remove'
            aria-label={`Remove ${addon.name}`}
            onClick={() => onRemove(addon.id)}
            disabled={isWorking}
            className='flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 opacity-100 transition-all hover:bg-red-500/15 hover:text-red-400 disabled:opacity-40 md:opacity-0 md:group-focus-within/row:opacity-100 md:group-hover/row:opacity-100'
          >
            <Trash2 className='h-4 w-4' />
          </button>
        )}
        <SettingsSwitch
          ariaLabel={addon.enabled ? `Disable ${addon.name}` : `Enable ${addon.name}`}
          checked={addon.enabled}
          disabled={isWorking}
          onChange={() => onToggle(addon.id)}
        />
      </div>
    </>
  );
}

const ADDON_ROW_CLASS =
  'group/row flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-white/[0.02]';

function SortableAddonRow(props: Omit<AddonRowProps, 'handle' | 'pinned'>) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.addon.id,
    disabled: props.isWorking,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        ADDON_ROW_CLASS,
        isDragging && 'relative z-10 bg-zinc-950 ring-1 ring-white/15 shadow-xl',
      )}
    >
      <AddonRow
        {...props}
        handle={
          <button
            type='button'
            {...attributes}
            {...listeners}
            disabled={props.isWorking}
            className='-m-1 cursor-grab touch-none rounded-md p-1 text-zinc-500 transition-colors hover:bg-white/[0.05] hover:text-zinc-200 active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-30'
            aria-label='Drag to reorder'
          >
            <GripVertical className='h-4 w-4 shrink-0' />
          </button>
        }
      />
    </div>
  );
}

// Pinned rows live outside DndContext — a plain row, no sortable wiring.
function PinnedAddonRow(props: Omit<AddonRowProps, 'handle' | 'pinned'>) {
  return (
    <div className={ADDON_ROW_CLASS}>
      <AddonRow
        {...props}
        pinned
        handle={
          <span
            className='-m-1 cursor-default p-1 text-zinc-600'
            title={`${props.addon.name} is a default addon and cannot be moved`}
          >
            <GripVertical className='h-4 w-4 shrink-0 opacity-30' />
          </span>
        }
      />
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

// Mirrors the backend's DEFAULT_ADDON_INSTALLS pinning — these rows render
// outside the sortable list and can only be toggled, not moved or removed.
const DEFAULT_ADDON_BASE_URLS: ReadonlySet<string> = new Set([
  'https://v3-cinemeta.strem.io',
  'https://opensubtitles-v3.strem.io',
]);

export function StreamingSources() {
  const queryClient = useQueryClient();
  const [newUrl, setNewUrl] = useState('');
  const newUrlInputRef = useRef<HTMLInputElement | null>(null);

  const { data: addons = [], isLoading, isLoadingError, isRefetching, refetch } = useAddonConfigs();

  const saveMutation = useMutation({
    mutationFn: api.saveAddonConfigs,
    onSuccess: (savedConfigs) => {
      queryClient.setQueryData(ADDON_CONFIGS_QUERY_KEY, savedConfigs);
      void invalidateStreamQueries(queryClient);
      void invalidateDiscoveryQueries(queryClient);
    },
    onError: (err: unknown) => toast.error(getErrorMessage(err)),
  });

  const sensors = useSortableSensors();

  // One URL parse per addon per list change: the previous form re-parsed
  // every addon URL on each keystroke in the add box plus again in every
  // toggle/drag/remove handler.
  const normalizedAddonUrls = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const addon of addons) {
      map.set(addon.id, normalizeAddonUrl(addon.url));
    }
    return map;
  }, [addons]);

  const normalizedNewUrl = useMemo(() => normalizeAddonUrl(newUrl), [newUrl]);
  const isConfigureCandidate = normalizedNewUrl ? isConfigureUrl(normalizedNewUrl) : false;
  const duplicateAddon = normalizedNewUrl
    ? addons.find((addon) => normalizedAddonUrls.get(addon.id) === normalizedNewUrl)
    : undefined;
  // A failed read leaves `addons` empty; every edit saves the whole list, so
  // editing then would overwrite the stored sources.
  const isWorking = isLoading || isLoadingError || saveMutation.isPending;
  const canSubmitNewAddon =
    !!newUrl.trim() && !!normalizedNewUrl && !isConfigureCandidate && !duplicateAddon && !isWorking;

  const handleToggle = (id: string) => {
    const updated = addons.map((a) => (a.id === id ? { ...a, enabled: !a.enabled } : a));
    saveMutation.mutate(updated);
  };

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      // A toggle/remove save in flight means `addons` is stale — a reorder
      // built on it would whole-list overwrite the pending change.
      if (!over || active.id === over.id || isWorking) return;

      // Default addons are pinned on top; only user addons below them reorder.
      const isPinned = (url: string | null) => url !== null && DEFAULT_ADDON_BASE_URLS.has(url);
      const rest = addons.filter((addon) => !isPinned(normalizedAddonUrls.get(addon.id) ?? null));
      const oldIndex = rest.findIndex((addon) => addon.id === String(active.id));
      const newIndex = rest.findIndex((addon) => addon.id === String(over.id));
      if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return;

      const pinned = addons.filter((addon) => isPinned(normalizedAddonUrls.get(addon.id) ?? null));
      saveMutation.mutate([...pinned, ...arrayMove(rest, oldIndex, newIndex)]);
    },
    [addons, isWorking, normalizedAddonUrls, saveMutation],
  );

  const handleRemove = (id: string) => {
    saveMutation.mutate(
      addons.filter((a) => a.id !== id),
      { onSuccess: () => toast.success('Addon removed') },
    );
  };

  const handleAddUrl = () => {
    // Enter in the input bypasses the disabled button — re-check everything
    // the gate already proved via the memoized values.
    if (isWorking || !newUrl.trim()) return;

    if (!normalizedNewUrl) {
      toast.error('Invalid addon URL. Please use a valid http(s) or stremio:// URL.');
      return;
    }
    if (isConfigureCandidate) {
      toast.error(
        'This is a configure page — open it, finish setup, then paste the generated manifest URL.',
      );
      return;
    }
    if (duplicateAddon) {
      toast.error(`This addon URL is already configured as ${duplicateAddon.name}.`);
      return;
    }

    // One save classifies the URL server-side — the host label is a
    // placeholder the backend replaces with the manifest name.
    const newAddon: AddonConfigInput = {
      id: generateId(),
      url: normalizedNewUrl,
      name: deriveAddonNameFromUrl(normalizedNewUrl),
      enabled: true,
    };
    saveMutation.mutate([...addons, newAddon], {
      onSuccess: (savedConfigs) => {
        setNewUrl('');
        newUrlInputRef.current?.focus();
        const added = savedConfigs.find((addon) => addon.id === newAddon.id);
        toast.success(`Added ${added?.name ?? newAddon.name}`);
      },
    });
  };

  const activeCount = addons.filter((a) => a.enabled).length;
  const pinnedAddons = useMemo(
    () =>
      addons.filter((addon) =>
        DEFAULT_ADDON_BASE_URLS.has(normalizedAddonUrls.get(addon.id) ?? ''),
      ),
    [addons, normalizedAddonUrls],
  );
  const userAddons = useMemo(
    () =>
      addons.filter(
        (addon) => !DEFAULT_ADDON_BASE_URLS.has(normalizedAddonUrls.get(addon.id) ?? ''),
      ),
    [addons, normalizedAddonUrls],
  );

  return (
    <SettingsGroup>
      <SettingsGroupHeader
        title='Addons'
        description='Cinemeta (metadata) and OpenSubtitles (subtitles) are pinned defaults. Drag other addons to set stream priority.'
        action={
          addons.length > 0 ? (
            <span className='rounded-md bg-white/[0.05] px-2 py-1 text-[11px] font-semibold tabular-nums text-zinc-400'>
              {activeCount}/{addons.length} active
            </span>
          ) : undefined
        }
      />

      <div className='border-b border-white/[0.06] px-5 py-4'>
        <div className='flex flex-col gap-2 sm:flex-row'>
          <Input
            ref={newUrlInputRef}
            aria-label='Addon manifest URL'
            placeholder='https://addon.host/.../manifest.json'
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddUrl()}
            disabled={isWorking}
            className='h-10 flex-1 rounded-xl border-white/[0.08] bg-white/[0.04] px-3.5 font-mono text-[13px] focus-visible:ring-1 focus-visible:ring-white/20 focus-visible:ring-offset-0'
          />
          <Button
            size='sm'
            onClick={handleAddUrl}
            disabled={!canSubmitNewAddon}
            className='h-10 shrink-0 gap-2 rounded-xl bg-white px-4 text-[13px] font-semibold text-black hover:bg-zinc-200'
          >
            {saveMutation.isPending ? (
              <Loader2 className='h-4 w-4 animate-spin' />
            ) : (
              <Plus className='h-4 w-4' />
            )}
            Add addon
          </Button>
        </div>

        {newUrl.trim() ? (
          <p
            className={cn(
              'mt-2.5 text-[12px] font-medium',
              !normalizedNewUrl
                ? 'text-red-400'
                : isConfigureCandidate || duplicateAddon
                  ? 'text-amber-400'
                  : 'text-emerald-400',
            )}
          >
            {!normalizedNewUrl
              ? 'Enter a valid http(s) or stremio:// addon URL.'
              : isConfigureCandidate
                ? 'This is a configure page — open it, finish setup, then paste the generated manifest URL.'
                : duplicateAddon
                  ? `Already configured as ${duplicateAddon.name}.`
                  : `Ready: ${normalizedNewUrl}`}
          </p>
        ) : (
          <p className='mt-2.5 text-[12px] leading-relaxed text-zinc-600'>
            Paste a Stremio{' '}
            <code className='rounded bg-white/[0.05] px-1 py-0.5 font-mono text-[11px] text-zinc-500'>
              manifest.json
            </code>{' '}
            or{' '}
            <code className='rounded bg-white/[0.05] px-1 py-0.5 font-mono text-[11px] text-zinc-500'>
              stremio://
            </code>{' '}
            URL to add streams, catalogs, and subtitles.
          </p>
        )}
      </div>

      {isLoading ? (
        <SettingsBody className='flex items-center gap-3 text-[13px] text-zinc-500'>
          <Loader2 className='h-4 w-4 animate-spin' />
          Loading sources…
        </SettingsBody>
      ) : isLoadingError ? (
        <SettingsBody className='flex items-center justify-between gap-3 text-[13px] text-zinc-400'>
          <span role='alert'>Couldn't load your sources.</span>
          <Button
            variant='outline'
            size='sm'
            className={SETTINGS_OUTLINE_BUTTON_CLASS}
            disabled={isRefetching}
            onClick={() => void refetch()}
          >
            {isRefetching && <Loader2 className='h-3.5 w-3.5 animate-spin' />}
            Retry
          </Button>
        </SettingsBody>
      ) : (
        // No empty state: the backend always pins the default addons, so a
        // successful load can never return an empty list.
        <div className='divide-y divide-white/[0.05]'>
          {pinnedAddons.map((addon) => (
            <PinnedAddonRow
              key={addon.id}
              addon={addon}
              isWorking={isWorking}
              onToggle={handleToggle}
            />
          ))}
          {userAddons.length > 0 && (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={userAddons.map((a) => a.id)}
                strategy={verticalListSortingStrategy}
              >
                <div className='divide-y divide-white/[0.05]'>
                  {userAddons.map((addon) => (
                    <SortableAddonRow
                      key={addon.id}
                      addon={addon}
                      isWorking={isWorking}
                      onToggle={handleToggle}
                      onRemove={handleRemove}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </div>
      )}
    </SettingsGroup>
  );
}
