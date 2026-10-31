import { Fragment } from 'react';
import { Link } from 'react-router';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { MediaDetails } from '@/lib/api';

const EMPTY_CREDIT_NAMES: string[] = [];

export function CreditLink({ name }: { name: string }) {
  return (
    <Link
      to={`/search?q=${encodeURIComponent(name)}`}
      title={`Search for ${name}`}
      className='rounded-sm text-white/80 decoration-white/30 underline-offset-4 transition-colors hover:text-white hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40'
    >
      {name}
    </Link>
  );
}

const CREDIT_GROUP_KEYS = ['cast', 'directors', 'writers'] as const;

export function DetailsCredits({
  cast = EMPTY_CREDIT_NAMES,
  directors = EMPTY_CREDIT_NAMES,
  writers = EMPTY_CREDIT_NAMES,
}: Pick<MediaDetails, 'cast' | 'directors' | 'writers'>) {
  if (!cast.length && !directors.length && !writers.length) return null;

  return (
    <dl className='mt-4 grid max-w-2xl grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2 text-[13px] leading-6 sm:gap-x-4'>
      {[cast, directors, writers].map((names, groupIndex) => {
        if (!names.length) return null;
        const isCast = groupIndex === 0;
        const groupKey = CREDIT_GROUP_KEYS[groupIndex];
        const label = isCast
          ? 'Starring'
          : names.length === 1
            ? groupIndex === 1
              ? 'Director'
              : 'Writer'
            : groupIndex === 1
              ? 'Directors'
              : 'Writers';
        const links = (isCast ? names.slice(0, 4) : names).map((name, index) => (
          <span key={name}>
            {index > 0 && (
              <span aria-hidden='true' className='text-zinc-500'>
                {' '}
                ·{' '}
              </span>
            )}
            <CreditLink name={name} />
          </span>
        ));
        return (
          <Fragment key={groupKey}>
            <dt className='text-[12px] font-medium text-zinc-400'>{label}</dt>
            <dd
              className={
                isCast ? 'flex min-w-0 items-baseline gap-2 text-white/80' : 'min-w-0 break-words'
              }
            >
              {isCast ? <span className='min-w-0 break-words'>{links}</span> : links}
              {isCast && names.length > 4 && (
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type='button'
                      aria-label='Full cast'
                      className='inline-flex min-h-6 shrink-0 items-center rounded-md border border-white/10 bg-white/[0.05] px-2 py-1 text-[11px] font-medium leading-none text-white/75 transition-colors duration-150 hover:border-white/25 hover:bg-white/[0.1] hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40'
                    >
                      +{names.length - 4}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    align='start'
                    sideOffset={8}
                    tabIndex={0}
                    aria-labelledby='details-full-cast-heading'
                    className='max-h-64 w-80 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain rounded-lg border-white/10 p-4 shadow-xl focus-visible:ring-2 focus-visible:ring-white/40'
                  >
                    <h2
                      id='details-full-cast-heading'
                      className='mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-white/40'
                    >
                      Full cast
                    </h2>
                    <ul
                      aria-labelledby='details-full-cast-heading'
                      className='grid grid-cols-2 gap-x-4 gap-y-2'
                    >
                      {names.map((name) => (
                        <li
                          key={name}
                          className='min-w-0 wrap-break-word text-[13px] leading-5 text-white/80'
                        >
                          <CreditLink name={name} />
                        </li>
                      ))}
                    </ul>
                  </PopoverContent>
                </Popover>
              )}
            </dd>
          </Fragment>
        );
      })}
    </dl>
  );
}
