import { getCurrentWindow } from '@tauri-apps/api/window';
import { ChevronLeft, ChevronRight, Maximize2, Minimize2, Minus, X } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';
import { isTauriDesktopRuntime } from '@/lib/app-updater';
import { navigateBack, navigateForward, useNavigationHistoryState } from '@/lib/navigation';
import { cn } from '@/lib/utils';

interface DesktopTitlebarProps {
  className?: string;
  /** Browse pages only — the player owns its own Back control. */
  historyControls?: boolean;
}

const HISTORY_BUTTON_CLASS =
  'flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition-colors duration-150 hover:bg-white/[0.06] hover:text-white focus:outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/30 disabled:pointer-events-none disabled:opacity-25';

function TitlebarHistoryControls() {
  const { canGoBack, canGoForward } = useNavigationHistoryState();
  return (
    <div data-tauri-drag-region='false' className='flex items-center gap-0.5 px-2'>
      <button
        type='button'
        onClick={() => navigateBack()}
        disabled={!canGoBack}
        className={HISTORY_BUTTON_CLASS}
        aria-label='Go back'
        title='Back (Alt+Left)'
        aria-keyshortcuts='Alt+ArrowLeft'
      >
        <ChevronLeft aria-hidden='true' className='h-4 w-4' strokeWidth={2} />
      </button>
      <button
        type='button'
        onClick={() => void navigateForward()}
        disabled={!canGoForward}
        className={HISTORY_BUTTON_CLASS}
        aria-label='Go forward'
        title='Forward (Alt+Right)'
        aria-keyshortcuts='Alt+ArrowRight'
      >
        <ChevronRight aria-hidden='true' className='h-4 w-4' strokeWidth={2} />
      </button>
    </div>
  );
}

export const DesktopTitlebar = memo(function DesktopTitlebar({
  className,
  historyControls = false,
}: DesktopTitlebarProps = {}) {
  const isDesktopRuntime = isTauriDesktopRuntime();
  const appWindow = useMemo(
    () => (isDesktopRuntime ? getCurrentWindow() : null),
    [isDesktopRuntime],
  );
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (!appWindow) return;

    let isActive = true;
    let unlisten: (() => void) | undefined;
    let resizeTimer: number | undefined;
    let syncGeneration = 0;

    const syncWindowState = async () => {
      const generation = ++syncGeneration;
      try {
        const nextValue = await appWindow.isMaximized();
        if (isActive && generation === syncGeneration) {
          setIsMaximized(nextValue);
        }
      } catch {
        if (isActive && generation === syncGeneration) {
          setIsMaximized(false);
        }
      }
    };

    const scheduleWindowStateSync = () => {
      if (!isActive) return;
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = undefined;
        void syncWindowState();
      }, 150);
    };

    void syncWindowState();
    void appWindow
      .onResized(scheduleWindowStateSync)
      .then((dispose) => {
        if (!isActive) {
          dispose();
          return;
        }

        unlisten = dispose;
      })
      .catch(() => undefined);

    return () => {
      isActive = false;
      window.clearTimeout(resizeTimer);
      unlisten?.();
    };
  }, [appWindow]);

  const handleToggleMaximize = () => {
    if (!appWindow) return;
    void appWindow.toggleMaximize().catch(() => undefined);
  };

  return (
    <div className={cn('fixed inset-x-0 top-0 z-80 flex h-8 items-stretch', className)}>
      {historyControls && <TitlebarHistoryControls />}

      {/* Drag region fills remaining space */}
      <button
        type='button'
        data-tauri-drag-region
        aria-label='Toggle maximize window'
        className='flex min-w-0 flex-1 items-center select-none focus:outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/20'
        onDoubleClick={handleToggleMaximize}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') {
            return;
          }

          event.preventDefault();
          handleToggleMaximize();
        }}
      />

      {/* Window controls — flush right */}
      <div className='flex items-stretch'>
        <TitlebarButton
          label='Minimize'
          onClick={() => {
            if (!appWindow) return;
            void appWindow.minimize().catch(() => undefined);
          }}
          disabled={!appWindow}
        >
          <Minus className='h-3.5 w-3.5' strokeWidth={2.25} />
        </TitlebarButton>
        <TitlebarButton
          label={isMaximized ? 'Restore' : 'Maximize'}
          onClick={handleToggleMaximize}
          disabled={!appWindow}
        >
          {isMaximized ? (
            <Minimize2 className='h-3.5 w-3.5' strokeWidth={2.25} />
          ) : (
            <Maximize2 className='h-3.5 w-3.5' strokeWidth={2.25} />
          )}
        </TitlebarButton>
        <TitlebarButton
          label='Close'
          onClick={() => {
            if (!appWindow) return;
            void appWindow.close().catch(() => undefined);
          }}
          disabled={!appWindow}
          tone='danger'
        >
          <X className='h-3.5 w-3.5' strokeWidth={2.25} />
        </TitlebarButton>
      </div>
    </div>
  );
});

interface TitlebarButtonProps {
  children: React.ReactNode;
  disabled: boolean;
  label: string;
  onClick: () => void;
  tone?: 'danger';
}

function TitlebarButton({ children, disabled, label, onClick, tone }: TitlebarButtonProps) {
  return (
    <button
      type='button'
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-full w-12 items-center justify-center text-white transition-colors duration-150',
        'focus:outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/30',
        'disabled:cursor-not-allowed disabled:opacity-40',
        tone === 'danger' ? 'hover:bg-red-500/80' : 'hover:bg-white/[0.1]',
      )}
    >
      {children}
    </button>
  );
}
