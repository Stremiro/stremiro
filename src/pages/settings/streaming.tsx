import { closestCenter, DndContext, type DragEndEvent } from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GripVertical, Loader2, Plus, Trash2 } from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { RetryBanner } from '@/components/retry-banner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { type AddonConfig, api, getErrorMessage } from '@/lib/api';
import {
  ADDON_CONFIGS_QUERY_KEY,
  addonUrlInspectionQueryKey,
  invalidateDiscoveryQueries,
  invalidateStreamQueries,
} from '@/lib/query-invalidation';
import { useAddonConfigs } from '@/hooks/use-addon-configs';
import { useDebounce } from '@/hooks/use-debounce';
import { useSortableSensors } from '@/hooks/use-sortable-sensors';
import { cn } from '@/lib/utils';
import { SettingsBody, SettingsGroup, SettingsGroupHeader, SettingsSwitch } from './chrome';

// Long enough to skip per-keystroke IPC, short enough to read as live.
const ADDON_URL_INSPECT_DEBOUNCE_MS = 150;
const ADDON_URL_INVALID_MESSAGE = 'Enter a valid http(s) or stremio:// addon URL.';
const ADDON_URL_CONFIGURE_MESSAGE =
  'This is a configure page — open it, finish setup, then paste the generated manifest URL.';

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
          <span title={addon.name} className='truncate text-[13.5px] font-medium text-zinc-100'>
            {addon.name}
          </span>
          {pinned ? (
            <span className='shrink-0 rounded-md border border-white/10 bg-white/[0.06] px-1.5 py-px text-[9.5px] font-bold uppercase tracking-wider text-zinc-400'>
              Default
            </span>
          ) : null}
        </div>
        <p
          data-selectable='true'
          title={addon.displayUrl}
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
            className='flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 opacity-100 transition-colors hover:bg-red-500/15 hover:text-red-400 disabled:opacity-40 md:opacity-0 md:group-focus-within/row:opacity-100 md:group-hover/row:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/25'
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
            className='-ml-2 flex h-8 w-8 shrink-0 items-center justify-center cursor-grab touch-none rounded-md text-zinc-500 transition-colors hover:bg-white/[0.05] hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-30'
            aria-label={`Reorder ${props.addon.name}`}
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
            className='-ml-2 flex h-8 w-8 shrink-0 items-center justify-center cursor-default text-zinc-600'
            title={`${props.addon.name} is a default addon and cannot be moved`}
          >
            <GripVertical className='h-4 w-4 shrink-0 opacity-30' />
          </span>
        }
      />
    </div>
  );
}

export function StreamingSources() {
  const queryClient = useQueryClient();
  const [newUrl, setNewUrl] = useState('');
  const newUrlInputRef = useRef<HTMLInputElement | null>(null);

  const { data: addons = [], isLoading, isLoadingError, isRefetching, refetch } = useAddonConfigs();

  const saveMutation = useMutation({
    mutationFn: api.updateAddonConfigs,
    onSuccess: (savedConfigs) => {
      void queryClient.cancelQueries({ queryKey: ADDON_CONFIGS_QUERY_KEY, exact: true });
      queryClient.setQueryData(ADDON_CONFIGS_QUERY_KEY, savedConfigs);
      void invalidateStreamQueries(queryClient);
      void invalidateDiscoveryQueries(queryClient);
    },
    onError: (err: unknown) => toast.error(getErrorMessage(err)),
  });

  const sensors = useSortableSensors();

  // Rust judges the add box with the normalizer the save path stores with,
  // so validity, configure-page and duplicate verdicts can't drift from it.
  const trimmedNewUrl = newUrl.trim();
  const debouncedNewUrl = useDebounce(trimmedNewUrl, ADDON_URL_INSPECT_DEBOUNCE_MS);
  const installedAddonUrls = useMemo(() => addons.map((addon) => addon.url), [addons]);
  const inspectionQuery = useQuery({
    queryKey: addonUrlInspectionQueryKey(debouncedNewUrl, installedAddonUrls),
    queryFn: () => api.inspectAddonUrl(debouncedNewUrl),
    enabled: debouncedNewUrl !== '',
    staleTime: Infinity,
    retry: false,
  });
  // A verdict only describes the text on screen; mid-debounce there is none.
  const inspectionCurrent = trimmedNewUrl !== '' && debouncedNewUrl === trimmedNewUrl;
  const inspection = inspectionCurrent ? inspectionQuery.data : undefined;
  const normalizedNewUrl = inspection?.normalizedUrl;
  const isConfigureCandidate = !!inspection?.configurePage;
  const duplicateAddonName = inspection?.duplicateOf;
  const isWorking = isLoading || isLoadingError || saveMutation.isPending;
  const canSubmitNewAddon =
    !!normalizedNewUrl && !isConfigureCandidate && !duplicateAddonName && !isWorking;

  const handleToggle = (id: string) => {
    if (isWorking) return;
    const addon = addons.find((config) => config.id === id);
    if (addon) saveMutation.mutate({ kind: 'setEnabled', id, enabled: !addon.enabled });
  };

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id || isWorking) return;

      // Backend-pinned defaults stay on top; only user addons below them reorder.
      const rest = addons.filter((addon) => !addon.pinned);
      const oldIndex = rest.findIndex((addon) => addon.id === String(active.id));
      const newIndex = rest.findIndex((addon) => addon.id === String(over.id));
      if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return;

      saveMutation.mutate({
        kind: 'reorder',
        ids: arrayMove(rest, oldIndex, newIndex).map((addon) => addon.id),
      });
    },
    [addons, isWorking, saveMutation],
  );

  const handleRemove = (id: string) => {
    if (isWorking) return;
    saveMutation.mutate(
      { kind: 'remove', id },
      { onSuccess: () => toast.success('Addon removed') },
    );
  };

  const handleAddUrl = () => {
    // Enter bypasses the disabled button and can land mid-debounce; Rust
    // re-judges validity, configure pages and duplicates at commit.
    if (isWorking || !trimmedNewUrl) return;

    const knownIds = new Set(addons.map((addon) => addon.id));
    saveMutation.mutate(
      { kind: 'add', url: trimmedNewUrl },
      {
        onSuccess: (savedConfigs) => {
          setNewUrl('');
          requestAnimationFrame(() => newUrlInputRef.current?.focus());
          const added = savedConfigs.find((addon) => !knownIds.has(addon.id));
          toast.success(`Added ${added?.name ?? 'Addon'}`);
        },
      },
    );
  };

  const activeCount = addons.filter((a) => a.enabled).length;
  const pinnedAddons = useMemo(() => addons.filter((addon) => addon.pinned), [addons]);
  const userAddons = useMemo(() => addons.filter((addon) => !addon.pinned), [addons]);

  return (
    <SettingsGroup>
      <SettingsGroupHeader
        title='Addons'
        description='Cinemeta (metadata) and OpenSubtitles (subtitles) are pinned defaults. Drag other addons to set stream priority.'
        action={
          addons.length > 0 ? (
            <span className='text-[12px] tabular-nums text-zinc-400'>
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
            aria-describedby='addon-url-hint'
            aria-invalid={!!trimmedNewUrl && !!inspection && !normalizedNewUrl}
            placeholder='https://addon.host/.../manifest.json'
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddUrl();
            }}
            disabled={isWorking}
            className='h-10 flex-1 rounded-lg border-white/[0.08] bg-white/[0.04] px-3.5 font-mono text-[13px] focus-visible:ring-1 focus-visible:ring-white/20 focus-visible:ring-offset-0'
          />
          <Button
            size='sm'
            onClick={handleAddUrl}
            disabled={!canSubmitNewAddon}
            className='h-10 shrink-0 gap-2 rounded-lg bg-white px-4 text-[13px] font-medium text-black hover:bg-zinc-200'
          >
            {saveMutation.isPending ? (
              <Loader2 className='h-4 w-4 animate-spin' />
            ) : (
              <Plus className='h-4 w-4' />
            )}
            Add addon
          </Button>
        </div>

        {trimmedNewUrl ? (
          <p
            id='addon-url-hint'
            className={cn(
              'mt-2.5 text-[12px] leading-relaxed [overflow-wrap:anywhere]',
              !inspection
                ? inspectionCurrent && inspectionQuery.isError
                  ? 'text-red-400'
                  : 'text-zinc-500'
                : !normalizedNewUrl
                  ? 'text-red-400'
                  : isConfigureCandidate || duplicateAddonName
                    ? 'text-amber-400'
                    : 'text-emerald-400',
            )}
          >
            {!inspection
              ? inspectionCurrent && inspectionQuery.isError
                ? getErrorMessage(inspectionQuery.error)
                : 'Checking…'
              : !normalizedNewUrl
                ? (inspection.error ?? ADDON_URL_INVALID_MESSAGE)
                : isConfigureCandidate
                  ? ADDON_URL_CONFIGURE_MESSAGE
                  : duplicateAddonName
                    ? `Already configured as ${duplicateAddonName}.`
                    : `Ready: ${normalizedNewUrl}`}
          </p>
        ) : (
          <p id='addon-url-hint' className='mt-2.5 text-[12px] leading-relaxed text-zinc-400'>
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
        <SettingsBody>
          <RetryBanner
            message="Couldn't load your sources."
            onRetry={() => void refetch()}
            isRetrying={isRefetching}
          />
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
