import * as React from 'react';

import { handleRovingGroupKeyDown } from '@/lib/dom';
import { cn } from '@/lib/utils';

type TabsContextValue = {
  baseId: string;
  value: string;
  setValue: (value: string) => void;
};

const TabsContext = React.createContext<TabsContextValue | null>(null);

type TabsProps = React.HTMLAttributes<HTMLDivElement> & {
  value: string;
  onValueChange: (value: string) => void;
};

function Tabs({ className, value, onValueChange, ...props }: TabsProps) {
  const baseId = React.useId();
  const contextValue = React.useMemo(
    () => ({ baseId, value, setValue: onValueChange }),
    [baseId, value, onValueChange],
  );

  return (
    <TabsContext value={contextValue}>
      <div className={cn('w-full', className)} {...props} />
    </TabsContext>
  );
}

function useTabsContext() {
  const ctx = React.use(TabsContext);
  if (!ctx) throw new Error('Tabs components must be used within <Tabs />');
  return ctx;
}

function TabsList({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      role='tablist'
      className={cn(
        'inline-flex h-10 items-center justify-center rounded-md bg-muted p-1 text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

type TabsTriggerProps = React.ComponentProps<'button'> & { value: string };

function TabsTrigger({ className, onClick, onKeyDown, value, ...props }: TabsTriggerProps) {
  const ctx = useTabsContext();
  const isActive = ctx.value === value;
  const triggerId = `${ctx.baseId}-trigger-${value}`;
  const panelId = `${ctx.baseId}-panel-${value}`;

  return (
    <button
      type='button'
      role='tab'
      id={triggerId}
      aria-controls={panelId}
      className={cn(
        'inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium ring-offset-background transition-[color,background-color,box-shadow,opacity] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
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
        handleRovingGroupKeyDown(event, 'tab');
      }}
      {...props}
    />
  );
}

type TabsContentProps = React.ComponentProps<'div'> & { value: string };

function TabsContent({ className, value, ...props }: TabsContentProps) {
  const ctx = useTabsContext();
  const triggerId = `${ctx.baseId}-trigger-${value}`;
  const panelId = `${ctx.baseId}-panel-${value}`;

  if (ctx.value !== value) return null;

  return (
    <div
      role='tabpanel'
      id={panelId}
      aria-labelledby={triggerId}
      className={cn('mt-2 animate-surface-in motion-reduce:animate-none', className)}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
