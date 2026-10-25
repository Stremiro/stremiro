import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import * as React from 'react';

import { cn } from '@/lib/utils';

const TooltipProvider = TooltipPrimitive.Provider;

const Tooltip = TooltipPrimitive.Root;

const TooltipTrigger = TooltipPrimitive.Trigger;

function TooltipContent({
  className,
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Content
      sideOffset={sideOffset}
      className={cn(
        'z-50 origin-(--radix-tooltip-content-transform-origin) overflow-hidden rounded-md border border-white/10 bg-zinc-950/95 px-3 py-2 text-[13px] leading-relaxed text-zinc-100 shadow-xl animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 motion-reduce:animate-none motion-reduce:data-[state=closed]:animate-none',
        className,
      )}
      {...props}
    />
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
