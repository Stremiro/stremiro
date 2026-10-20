import { closestCenter, DndContext, type DragEndEvent } from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, GripVertical, Link2, Loader2, Plus, Trash2 } from 'lucide-react';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { RetryBanner } from '@/components/retry-banner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { type AddonConfig, api, getErrorMessage } from '@/lib/api';
import { copyText } from '@/lib/notify';
import {
  ADDON_CONFIGS_QUERY_KEY,
  addonUrlInspectionQueryKey,
  invalidateDiscoveryQueries,
} from '@/lib/query-invalidation';
import { useAddonConfigs } from '@/hooks/use-addon-configs';
import { useDebounce } from '@/hooks/use-debounce';
import { useMountedRef } from '@/hooks/use-mounted-ref';
import { useSortableSensors } from '@/hooks/use-sortable-sensors';
import { cn, queryNeedsRetry } from '@/lib/utils';
import {
  SETTINGS_HEADER_STATUS_CLASS,
  SettingsBody,
  SettingsGroup,
  SettingsGroupHeader,
  SettingsQueryError,
  SettingsSwitch,
} from './chrome';

// Long enough to skip per-keystroke IPC, short enough to read as live.
const ADDON_URL_INSPECT_DEBOUNCE_MS = 150;
const ADDON_URL_INVALID_MESSAGE = 'Enter a valid http(s) or stremio:// addon URL.';

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

const ADDON_ICON_BUTTON_CLASS =
  'flex h-8 w-8 items-center justify-center rounded-lg transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-(--accent-nav)/35';
const ADDON_COPIED_FEEDBACK_MS = 1600;

function addonMonogram(name: string) {
  return name.match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() ?? '?';
}

function AddonRow({ addon, handle, isWorking, pinned, onToggle, onRemove }: AddonRowProps) {
  const [copied, setCopied] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const removeConfirmedRef = useRef(false);
  const mountedRef = useMountedRef();
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), ADDON_COPIED_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const handleCopyLink = async () => {
    try {
      const url = await api.getAddonUrl(addon.id);
      const didCopy = await copyText(url, 'Addon link copied', 'Could not copy addon link');
      if (didCopy) {
        if (mountedRef.current) setCopied(true);
      }
    } catch {
      toast.error('Could not copy addon link');
    }
  };

  return (
    <>
      {handle}
      <div
        className={cn(
          'flex min-w-0 flex-1 items-center gap-3 transition-opacity',
          !addon.enabled && 'opacity-45',
        )}
      >
        <span
          aria-hidden='true'
          className='flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-white/[0.07] bg-linear-to-b from-white/[0.08] to-white/[0.02] text-[13px] font-semibold text-zinc-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]'
        >
          {addonMonogram(addon.name)}
        </span>
        <div className='min-w-0 flex-1'>
          <div className='flex min-w-0 items-center gap-2'>
            <span title={addon.name} className='truncate text-[13.5px] font-medium text-zinc-100'>
              {addon.name}
            </span>
            {pinned ? <span className='shrink-0 text-[11.5px] text-zinc-500'>Default</span> : null}
          </div>
          <p
            data-selectable='true'
            title={addon.displayUrl}
            className='mt-1 truncate font-mono text-[11.5px] leading-tight text-zinc-500'
          >
            {addon.displayUrl}
          </p>
        </div>
      </div>

      {/* Fixed slots keep controls column-aligned; pinned rows reserve the remove slot. */}
      <div className='col-start-2 flex shrink-0 items-center justify-self-end gap-1'>
        <button
          type='button'
          data-addon-control='copy'
          title={copied ? 'Copied' : 'Copy addon link'}
          aria-label={`Copy ${addon.name} addon link`}
          onClick={() => void handleCopyLink()}
          className={cn(
            ADDON_ICON_BUTTON_CLASS,
            copied ? 'text-(--accent-act)' : 'text-zinc-400 hover:bg-white/[0.06] hover:text-white',
          )}
        >
          {copied ? (
            <Check aria-hidden='true' className='h-4 w-4' />
          ) : (
            <Link2 aria-hidden='true' className='h-4 w-4' />
          )}
        </button>
        {!pinned && onRemove ? (
          <button
            type='button'
            data-addon-control='remove'
            title='Remove'
            aria-label={`Remove ${addon.name}`}
            onClick={() => {
              if (!isWorking) setRemoveOpen(true);
            }}
            aria-disabled={isWorking || undefined}
            className={cn(
              ADDON_ICON_BUTTON_CLASS,
              'text-zinc-500 not-aria-disabled:hover:bg-red-500/15 not-aria-disabled:hover:text-red-400 aria-disabled:opacity-40 md:opacity-0 md:group-focus-within/row:opacity-100 md:group-hover/row:opacity-100',
            )}
          >
            <Trash2 aria-hidden='true' className='h-4 w-4' />
          </button>
        ) : (
          <span aria-hidden='true' className='h-8 w-8' />
        )}
        <span aria-hidden='true' className='mx-2 h-5 w-px bg-white/[0.07]' />
        <SettingsSwitch
          ariaLabel={addon.enabled ? `Disable ${addon.name}` : `Enable ${addon.name}`}
          checked={addon.enabled}
          pending={isWorking}
          onChange={() => onToggle(addon.id)}
        />
      </div>
      <Dialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <DialogContent
          className='border-white/10 bg-zinc-950 sm:max-w-md'
          onCloseAutoFocus={() => {
            // Close first so the existing row-removal focus handoff still applies.
            if (!removeConfirmedRef.current) return;
            removeConfirmedRef.current = false;
            onRemove?.(addon.id);
          }}
        >
          <DialogHeader>
            <DialogTitle>Remove addon?</DialogTitle>
            <DialogDescription>
              Remove {addon.name} and its configuration? You can add it again using its addon URL.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant='outline' onClick={() => setRemoveOpen(false)}>
              Cancel
            </Button>
            <Button
              variant='destructive'
              disabled={isWorking}
              onClick={() => {
                removeConfirmedRef.current = true;
                setRemoveOpen(false);
              }}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

const ADDON_ROW_CLASS =
  'group/row grid grid-cols-[24px_minmax(0,1fr)] items-center gap-x-3 gap-y-2 px-4 py-3.5 transition-colors hover:bg-white/[0.02] sm:flex sm:gap-3 sm:px-5';

function SortableAddonRow(props: Omit<AddonRowProps, 'handle' | 'pinned'>) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.addon.id,
    disabled: props.isWorking,
  });

  return (
    <div
      ref={setNodeRef}
      data-addon-row={props.addon.id}
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
            data-addon-control='reorder'
            {...attributes}
            {...listeners}
            className='-ml-2 flex h-8 w-8 shrink-0 items-center justify-center cursor-grab touch-none rounded-md text-zinc-500 transition-colors hover:bg-white/[0.05] hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 active:cursor-grabbing aria-disabled:cursor-not-allowed aria-disabled:opacity-30'
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
    <div data-addon-row={props.addon.id} className={ADDON_ROW_CLASS}>
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
  const [isDragging, setIsDragging] = useState(false);
  const newUrlInputRef = useRef<HTMLInputElement | null>(null);
  const addonRowsRef = useRef<HTMLDivElement>(null);
  const removalFocusRef = useRef<{
    button: HTMLButtonElement;
    control: string;
    candidates: string[];
  } | null>(null);

  const addonsQuery = useAddonConfigs();
  const {
    data: addons = [],
    isLoading,
    isLoadingError,
    isFetched,
    isFetching,
    refetch,
  } = addonsQuery;

  const saveMutation = useMutation({
    mutationFn: api.updateAddonConfigs,
    onMutate: async (action) => {
      await queryClient.cancelQueries({ queryKey: ADDON_CONFIGS_QUERY_KEY, exact: true });
      const previous = queryClient.getQueryData<AddonConfig[]>(ADDON_CONFIGS_QUERY_KEY);
      if (action.kind === 'setEnabled') {
        queryClient.setQueryData(
          ADDON_CONFIGS_QUERY_KEY,
          previous?.map((addon) =>
            addon.id === action.id ? { ...addon, enabled: action.enabled } : addon,
          ),
        );
      }
      return previous;
    },
    onSuccess: (savedConfigs, action) => {
      if (action.kind === 'remove' && document.activeElement instanceof HTMLButtonElement) {
        const button = document.activeElement;
        const rows = Array.from(
          addonRowsRef.current?.querySelectorAll<HTMLElement>('[data-addon-row]') ?? [],
        );
        const index = rows.findIndex(
          (row) => row.dataset.addonRow === action.id && row.contains(button),
        );
        const control = button.dataset.addonControl
          ? `[data-addon-control="${button.dataset.addonControl}"]`
          : button.getAttribute('role') === 'switch'
            ? '[role="switch"]'
            : null;
        if (index >= 0 && control) {
          removalFocusRef.current = {
            button,
            control,
            candidates: [...rows.slice(index + 1), ...rows.slice(0, index).toReversed()].map(
              (row) => row.dataset.addonRow!,
            ),
          };
        }
      }
      void queryClient.cancelQueries({ queryKey: ADDON_CONFIGS_QUERY_KEY, exact: true });
      queryClient.setQueryData(ADDON_CONFIGS_QUERY_KEY, savedConfigs);
      void invalidateDiscoveryQueries(queryClient);
    },
    onError: (err: unknown, _action, previous) => {
      toast.error(getErrorMessage(err));
      if (previous) queryClient.setQueryData(ADDON_CONFIGS_QUERY_KEY, previous);
      // A failed disk save can still leave the registry applied in memory.
      return queryClient
        .fetchQuery({
          queryKey: ADDON_CONFIGS_QUERY_KEY,
          queryFn: api.getAddonConfigs,
          staleTime: 0,
        })
        .then((current) => {
          if (JSON.stringify(current) !== JSON.stringify(previous)) {
            void invalidateDiscoveryQueries(queryClient);
          }
        })
        .catch(() => {});
    },
  });

  useLayoutEffect(() => {
    const pending = removalFocusRef.current;
    if (!pending) return;
    if (pending.button.isConnected) {
      if (document.activeElement !== pending.button) removalFocusRef.current = null;
      return;
    }
    if (saveMutation.isPending) return;
    removalFocusRef.current = null;
    if (document.activeElement !== document.body) return;
    const controls = new Map(
      Array.from(
        addonRowsRef.current?.querySelectorAll<HTMLElement>('[data-addon-row]') ?? [],
        (row) =>
          [
            row.dataset.addonRow,
            row.querySelector<HTMLButtonElement>(`${pending.control}:not(:disabled)`),
          ] as const,
      ),
    );
    const nextId = pending.candidates.find((id) => controls.get(id));
    (controls.get(nextId) ?? newUrlInputRef.current)?.focus({ preventScroll: true });
  });

  const sensors = useSortableSensors();

  // Rust judges the add box with the save path's normalizer, so verdicts can't drift.
  const trimmedNewUrl = newUrl.trim();
  const debouncedNewUrl = useDebounce(trimmedNewUrl, ADDON_URL_INSPECT_DEBOUNCE_MS);
  const installedAddonIds = addons.map((addon) => addon.id);
  const inspectionQuery = useQuery({
    queryKey: addonUrlInspectionQueryKey(debouncedNewUrl, installedAddonIds),
    queryFn: () => api.inspectAddonUrl(debouncedNewUrl),
    enabled: debouncedNewUrl !== '',
    staleTime: Infinity,
    retry: false,
  });
  // A verdict only describes the text on screen; mid-debounce there is none.
  const inspectionCurrent = trimmedNewUrl !== '' && debouncedNewUrl === trimmedNewUrl;
  const inspection = inspectionCurrent ? inspectionQuery.data : undefined;
  const isValidNewUrl = !!inspection?.displayUrl;
  const isConfigureCandidate = !!inspection?.configurePage;
  const duplicateAddonName = inspection?.duplicateOf;
  const isWorking = isLoading || isLoadingError || saveMutation.isPending;
  const canSubmitNewAddon = isValidNewUrl && !duplicateAddonName && !isWorking;

  const handleToggle = (id: string) => {
    if (isWorking) return;
    const addon = addons.find((config) => config.id === id);
    if (addon) saveMutation.mutate({ kind: 'setEnabled', id, enabled: !addon.enabled });
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setIsDragging(false);
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
  };

  const handleRemove = (id: string) => {
    if (isWorking) return;
    saveMutation.mutate(
      { kind: 'remove', id },
      { onSuccess: () => toast.success('Addon removed') },
    );
  };

  const handleAddUrl = () => {
    // Enter bypasses the disabled button mid-debounce; Rust re-judges at commit.
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
  const pinnedAddons = addons.filter((addon) => addon.pinned);
  const userAddons = addons.filter((addon) => !addon.pinned);

  return (
    <SettingsGroup>
      <SettingsGroupHeader
        title='Addons'
        description='Cinemeta and OpenSubtitles are pinned defaults. Drag other addons to set stream priority.'
        action={
          addons.length > 0 ? (
            <span className={SETTINGS_HEADER_STATUS_CLASS}>
              {activeCount} of {addons.length} active
            </span>
          ) : undefined
        }
      />

      <SettingsBody className='border-b border-white/[0.06]'>
        <div className='flex flex-col gap-2 sm:flex-row'>
          <div className='relative flex-1'>
            <Link2
              aria-hidden='true'
              className='pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500'
            />
            <Input
              ref={newUrlInputRef}
              aria-label='Addon manifest URL'
              aria-describedby='addon-url-hint'
              aria-invalid={!!trimmedNewUrl && !!inspection && !isValidNewUrl}
              placeholder='https://addon.host/.../manifest.json'
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleAddUrl();
              }}
              disabled={isWorking}
              className='h-10 rounded-lg border-white/[0.08] bg-white/[0.04] pl-10 pr-3.5 font-mono text-[13px] transition-colors placeholder:text-zinc-600 focus-visible:border-(--accent-nav)/35 focus-visible:ring-1 focus-visible:ring-(--accent-nav)/25 focus-visible:ring-offset-0'
            />
          </div>
          <Button
            size='sm'
            onClick={handleAddUrl}
            disabled={!canSubmitNewAddon}
            className='h-10 shrink-0 gap-2 rounded-lg bg-white px-4 text-[13px] font-medium text-black hover:bg-zinc-200'
          >
            {saveMutation.isPending && saveMutation.variables?.kind === 'add' ? (
              <Loader2 className='h-4 w-4 animate-spin motion-reduce:animate-none' />
            ) : (
              <Plus className='h-4 w-4' />
            )}
            Add addon
          </Button>
        </div>

        {inspectionCurrent && !inspection && queryNeedsRetry(inspectionQuery) ? (
          <div id='addon-url-hint' className='mt-2.5'>
            <SettingsQueryError query={inspectionQuery} message="Couldn't check this addon URL." />
          </div>
        ) : trimmedNewUrl ? (
          <p
            id='addon-url-hint'
            className={cn(
              'mt-2.5 text-[12px] leading-relaxed [overflow-wrap:anywhere]',
              !inspection
                ? 'text-zinc-500'
                : isConfigureCandidate || duplicateAddonName
                  ? 'text-amber-400'
                  : !isValidNewUrl
                    ? 'text-red-400'
                    : 'text-emerald-400',
            )}
          >
            {!inspection
              ? 'Checking…'
              : !isValidNewUrl
                ? (inspection.error ?? ADDON_URL_INVALID_MESSAGE)
                : duplicateAddonName
                  ? `Already configured as ${duplicateAddonName}.`
                  : `Ready: ${inspection.displayUrl}`}
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
            URL to add an addon.
          </p>
        )}
      </SettingsBody>

      {isLoading && !isFetched ? (
        <SettingsBody className='flex items-center gap-3 text-[13px] text-zinc-500'>
          <Loader2 className='h-4 w-4 animate-spin' />
          Loading sources…
        </SettingsBody>
      ) : isLoadingError || (isFetched && isLoading) ? (
        <SettingsBody>
          <RetryBanner
            message="Couldn't load your sources."
            onRetry={() => void refetch()}
            isRetrying={isFetching}
          />
        </SettingsBody>
      ) : (
        // No empty state: the backend always pins default addons.
        <div
          ref={addonRowsRef}
          className='divide-y divide-white/[0.05]'
          data-escape-capture={isDragging ? '' : undefined}
        >
          <SettingsQueryError
            query={addonsQuery}
            className='mx-5 my-3'
            message="Couldn't refresh your sources."
          />
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
              onDragStart={() => setIsDragging(true)}
              onDragEnd={handleDragEnd}
              onDragCancel={() => setIsDragging(false)}
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
