import { cn, SIDEBAR_PAGE_COLUMN_INSETS } from '@/lib/utils';

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('animate-pulse rounded-md bg-primary/10 motion-reduce:animate-none', className)}
      {...props}
    />
  );
}

/** `progress-slide` bar — the moving segment; the caller's track supplies bounds and color. */
function IndeterminateBar({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden='true'
      className={cn(
        'h-full w-1/3 motion-safe:animate-[progress-slide_1.6s_linear_infinite]',
        className,
      )}
      {...props}
    />
  );
}

function RouteLoadingBar() {
  return (
    <div
      aria-hidden='true'
      className='delayed-fade-in pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5 overflow-hidden'
    >
      <IndeterminateBar className='bg-(--accent-nav) motion-safe:animate-[progress-slide_1.4s_cubic-bezier(0.4,0,0.2,1)_infinite]' />
    </div>
  );
}

// Shared by the route-chunk fallback and the metadata query to avoid two loading layouts.
function DetailsSkeleton() {
  return (
    <div className='relative min-h-[calc(100vh-2rem)] bg-background pb-20' aria-busy='true'>
      <RouteLoadingBar />
      <span role='status' className='sr-only'>
        Loading title details…
      </span>
      <div
        className='relative -mt-8 w-full pb-7 pt-16 sm:pb-9 sm:pt-20 lg:pt-24'
        aria-hidden='true'
      >
        <div className='absolute inset-0 bg-zinc-950' />
        <div className='absolute inset-0 bg-linear-to-t from-background via-background/60 to-transparent' />
        <div
          className={`relative z-20 mx-auto grid w-full max-w-[1440px] gap-6 sm:grid-cols-[148px_minmax(0,1fr)] lg:grid-cols-[184px_minmax(0,1fr)] lg:gap-8 ${SIDEBAR_PAGE_COLUMN_INSETS}`}
        >
          <Skeleton className='hidden aspect-2/3 w-full rounded-lg bg-zinc-800/50 sm:block' />
          <div className='min-w-0 space-y-4'>
            <div>
              <div className='mb-3 flex min-h-20 items-center md:min-h-24'>
                <Skeleton className='h-16 w-80 max-w-full bg-zinc-800/60 md:h-20' />
              </div>
              <div className='flex flex-wrap items-center gap-x-3 gap-y-2'>
                <Skeleton className='h-5 w-14 bg-zinc-800/50' />
                <Skeleton className='h-5 w-20 bg-zinc-800/50' />
                <Skeleton className='h-5 w-16 bg-zinc-800/50' />
              </div>
              <div className='mt-3 flex flex-wrap items-center gap-1.5'>
                <Skeleton className='h-7 w-20 rounded-md bg-zinc-800/50' />
                <Skeleton className='h-7 w-16 rounded-md bg-zinc-800/50' />
                <Skeleton className='h-7 w-20 rounded-md bg-zinc-800/50' />
              </div>
            </div>
            <div className='max-w-3xl space-y-2.5'>
              <Skeleton className='h-4 w-full bg-zinc-800/40' />
              <Skeleton className='h-4 w-full bg-zinc-800/40' />
              <Skeleton className='h-4 w-4/5 bg-zinc-800/40' />
            </div>
            <div className='flex flex-wrap gap-2.5'>
              <Skeleton className='h-11 w-36 max-w-full rounded-lg bg-zinc-800/50' />
              <Skeleton className='h-11 w-24 rounded-lg bg-zinc-800/40' />
              <Skeleton className='h-11 w-26 rounded-lg bg-zinc-800/40' />
            </div>
            <div className='flex flex-wrap items-center gap-2'>
              <Skeleton className='h-4 w-16 bg-zinc-800/40' />
              <div className='inline-grid max-w-full grid-cols-2 gap-1 sm:inline-flex sm:flex-wrap'>
                {[0, 1, 2, 3].map((index) => (
                  <Skeleton key={index} className='h-9 w-24 rounded-md bg-zinc-800/40' />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
      <div
        className={`mx-auto w-full max-w-[1440px] space-y-4 ${SIDEBAR_PAGE_COLUMN_INSETS}`}
        aria-hidden='true'
      >
        <Skeleton className='h-9 w-28 bg-zinc-800/40' />
        <div className='grid grid-flow-col auto-cols-[82%] gap-4 overflow-hidden px-1 pt-1 sm:auto-cols-[calc((100%_-_1rem)/2.25)] lg:auto-cols-[calc((100%_-_2rem)/3.25)]'>
          {[0, 1, 2].map((index) => (
            <div key={index} className='space-y-3'>
              <Skeleton className='aspect-video w-full rounded-lg bg-zinc-800/40' />
              <Skeleton className='h-4 w-3/4 bg-zinc-800/40' />
              <Skeleton className='h-3 w-1/2 bg-zinc-800/30' />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
export { DetailsSkeleton, IndeterminateBar, RouteLoadingBar, Skeleton };
