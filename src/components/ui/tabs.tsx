import * as React from 'react';

import { cn } from '@/lib/utils';

type TabsContextValue = {
  baseId: string;
  value: string;
  setValue: (value: string) => void;
};

const TabsContext = React.createContext<TabsContextValue | null>(null);

type TabsProps = React.HTMLAttributes<HTMLDivElement> & {
  defaultValue?: string;
  value?: string;
  onValueChange?: (value: string) => void;
};

function Tabs({ className, defaultValue, value, onValueChange, ...props }: TabsProps) {
  const [internalValue, setInternalValue] = React.useState(defaultValue ?? '');
  const baseId = React.useId();
  const isControlled = value !== undefined;
  const currentValue = isControlled ? value : internalValue;

  const setValue = React.useCallback(
    (next: string) => {
      if (!isControlled) setInternalValue(next);
      onValueChange?.(next);
    },
    [isControlled, onValueChange],
  );

  const contextValue = React.useMemo<TabsContextValue>(
    () => ({ baseId, value: currentValue, setValue }),
    [baseId, currentValue, setValue],
  );

  return (
    <TabsContext.Provider value={contextValue}>
      <div className={cn('w-full', className)} {...props} />
    </TabsContext.Provider>
  );
}

function useTabsContext() {
  const ctx = React.useContext(TabsContext);
  if (!ctx) throw new Error('Tabs components must be used within <Tabs />');
  return ctx;
}

const TabsList = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      role='tablist'
      className={cn(
        'inline-flex h-10 items-center justify-center rounded-md bg-muted p-1 text-muted-foreground',
        className,
      )}
      {...props}
    />
  ),
);
TabsList.displayName = 'TabsList';

// Roving tabindex (`tabIndex` below) needs the matching half of the ARIA
// tabs pattern: arrows/Home/End move focus AND activate — without it, only
// the active tab is keyboard-reachable.
const TAB_NAVIGATION_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
]);

type TabsTriggerProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { value: string };

const TabsTrigger = React.forwardRef<HTMLButtonElement, TabsTriggerProps>(
  ({ className, onClick, onKeyDown, value, ...props }, ref) => {
    const ctx = useTabsContext();
    const isActive = ctx.value === value;
    const triggerId = `${ctx.baseId}-trigger-${value}`;
    const panelId = `${ctx.baseId}-panel-${value}`;

    return (
      <button
        ref={ref}
        type='button'
        role='tab'
        id={triggerId}
        aria-controls={panelId}
        className={cn(
          'inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium ring-offset-background transition-all focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
          isActive && 'bg-background text-foreground shadow-xs',
          className,
        )}
        aria-selected={isActive}
        tabIndex={isActive ? 0 : -1}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) {
            ctx.setValue(value);
          }
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented || !TAB_NAVIGATION_KEYS.has(event.key)) return;

          const tablist = event.currentTarget.closest('[role="tablist"]');
          const triggers = Array.from(
            tablist?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [],
          ).filter((trigger) => !trigger.disabled);
          const currentIndex = triggers.indexOf(event.currentTarget);
          if (currentIndex === -1) return;

          event.preventDefault();
          let nextIndex: number;
          if (event.key === 'Home') {
            nextIndex = 0;
          } else if (event.key === 'End') {
            nextIndex = triggers.length - 1;
          } else {
            const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
            nextIndex = (currentIndex + direction + triggers.length) % triggers.length;
          }
          const next = triggers[nextIndex];
          // `.click()` reuses the trigger's own activation path so key and
          // pointer selection can never diverge.
          next?.focus();
          next?.click();
        }}
        {...props}
      />
    );
  },
);
TabsTrigger.displayName = 'TabsTrigger';

type TabsContentProps = React.HTMLAttributes<HTMLDivElement> & { value: string };

const TabsContent = React.forwardRef<HTMLDivElement, TabsContentProps>(
  ({ className, value, ...props }, ref) => {
    const ctx = useTabsContext();
    const triggerId = `${ctx.baseId}-trigger-${value}`;
    const panelId = `${ctx.baseId}-panel-${value}`;

    if (ctx.value !== value) return null;

    return (
      <div
        ref={ref}
        role='tabpanel'
        id={panelId}
        aria-labelledby={triggerId}
        className={cn('mt-2', className)}
        {...props}
      />
    );
  },
);
TabsContent.displayName = 'TabsContent';

export { Tabs, TabsContent, TabsList, TabsTrigger };
