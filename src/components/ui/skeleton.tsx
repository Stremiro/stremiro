import { cn, SIDEBAR_PAGE_COLUMN_INSETS } from '@/lib/utils';

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('animate-pulse rounded-md bg-primary/10 motion-reduce:animate-none', className)}
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
      <div className='h-full w-1/3 bg-(--accent-nav) motion-safe:animate-[progress-slide_1.4s_cubic-bezier(0.4,0,0.2,1)_infinite]' />
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
        className='relative -mt-8 flex min-h-[70vh] w-full items-end pb-12 pt-24 lg:pb-16 lg:pt-28'
        aria-hidden='true'
      >
        <div className='absolute inset-0 bg-zinc-950' />
        <div className='absolute inset-0 bg-linear-to-t from-background via-background/60 to-transparent' />
        <div
          className={`relative z-20 mx-auto flex w-full max-w-6xl flex-col ${SIDEBAR_PAGE_COLUMN_INSETS}`}
        >
          <div className='w-full max-w-4xl space-y-6'>
            <div>
              <div className='mb-5 flex min-h-24 items-center md:min-h-32'>
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
            <div className='max-w-2xl space-y-2.5'>
              <Skeleton className='h-4 w-full bg-zinc-800/40' />
              <Skeleton className='h-4 w-full bg-zinc-800/40' />
              <Skeleton className='h-4 w-4/5 bg-zinc-800/40' />
            </div>
            <div className='flex flex-wrap gap-2.5 pt-2'>
              <Skeleton className='h-11 w-36 max-w-full rounded-lg bg-zinc-800/50' />
              <Skeleton className='h-11 w-24 rounded-lg bg-zinc-800/40' />
              <Skeleton className='h-11 w-26 rounded-lg bg-zinc-800/40' />
            </div>
            <div className='flex flex-col items-start gap-2 pt-5'>
              <Skeleton className='h-4 w-16 bg-zinc-800/40' />
              <div className='inline-grid max-w-full grid-cols-2 gap-1 rounded-xl border border-white/15 bg-zinc-950 p-1 sm:inline-flex sm:flex-wrap'>
                {[0, 1, 2, 3].map((index) => (
                  <Skeleton key={index} className='h-9 w-28 rounded-lg bg-zinc-800/40' />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export { DetailsSkeleton, RouteLoadingBar, Skeleton };
