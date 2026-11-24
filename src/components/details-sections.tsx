import { type ComponentProps, type ReactNode, useEffect, useRef, useState } from 'react';
import { CalendarClock, ChevronLeft, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { CreditLink } from '@/components/details-credits';
import { RemoteImage } from '@/components/remote-image';
import {
  DRAG_SCROLL_CLASS,
  scrollEdgeMask,
  useHorizontalDragScroll,
  useScrollEdgeIndicators,
} from '@/hooks/use-scroll-edge-indicators';
import {
  api,
  getErrorMessage,
  type MediaDetails,
  type NextAiringEpisode,
  type TitleCredits,
} from '@/lib/api';
import { isTauriDesktopRuntime } from '@/lib/app-updater';
import { cn, scrollBehavior } from '@/lib/utils';

// Link validation re-reads the cached credits, so it must use the query's media type.
export const creditsMediaType = ({ type, isAnime }: Pick<MediaDetails, 'type' | 'isAnime'>) =>
  type !== 'movie' && isAnime ? 'anime' : type;

function ExternalLink({
  item,
  href,
  onClick,
  children,
  ...props
}: ComponentProps<'a'> & { href: string; item: MediaDetails }) {
  return (
    <a
      {...props}
      href={href}
      target='_blank'
      rel='noopener noreferrer'
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || !isTauriDesktopRuntime()) return;
        event.preventDefault();
        void api
          .openTitleCreditsLink(creditsMediaType(item), item.id, item.imdbId, href)
          .catch((error) => toast.error(getErrorMessage(error)));
      }}
    >
      {children}
    </a>
  );
}

const SOURCE_LINK_CLASS =
  'rounded-xs underline-offset-4 hover:text-white/65 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40';

export const DETAILS_RAIL_BUTTON_CLASS =
  'flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.03] text-zinc-300 transition-colors duration-150 not-aria-disabled:hover:bg-white/[0.08] not-aria-disabled:hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40 aria-disabled:cursor-default aria-disabled:opacity-35 motion-reduce:transition-none';

function People({ people, characters }: Pick<TitleCredits, 'people'> & { characters: boolean }) {
  const scrollRef = useRef<HTMLUListElement>(null);
  const dragScrollProps = useHorizontalDragScroll<HTMLUListElement>();
  const { bind: bindScroller, ...scrollState } = useScrollEdgeIndicators(scrollRef);
  const edgeMask = scrollEdgeMask(scrollState);

  const scrollPeople = (direction: -1 | 1) => {
    if (direction < 0 ? !scrollState.canScrollLeft : !scrollState.canScrollRight) return;
    scrollRef.current?.scrollBy({
      left: direction * scrollRef.current.clientWidth * 0.8,
      behavior: scrollBehavior(),
    });
  };
  return (
    <div className='min-w-0'>
      <div className='mb-3 flex items-center justify-between gap-3'>
        <h2
          id='details-cast-heading'
          className='text-xl font-semibold leading-7 tracking-[-0.02em] text-zinc-100'
        >
          {characters ? 'Characters' : 'Cast'}
        </h2>
        {scrollState.hasOverflow && (
          <div
            role='group'
            aria-label={characters ? 'Character navigation' : 'Cast navigation'}
            className='flex items-center gap-1.5 sm:gap-2'
          >
            <button
              type='button'
              aria-label={characters ? 'Show previous characters' : 'Show previous cast'}
              aria-disabled={!scrollState.canScrollLeft || undefined}
              onClick={() => scrollPeople(-1)}
              className={DETAILS_RAIL_BUTTON_CLASS}
            >
              <ChevronLeft aria-hidden='true' className='h-4 w-4' />
            </button>
            <button
              type='button'
              aria-label={characters ? 'Show next characters' : 'Show next cast'}
              aria-disabled={!scrollState.canScrollRight || undefined}
              onClick={() => scrollPeople(1)}
              className={DETAILS_RAIL_BUTTON_CLASS}
            >
              <ChevronRight aria-hidden='true' className='h-4 w-4' />
            </button>
          </div>
        )}
      </div>
      <ul
        aria-label={characters ? 'Characters' : 'Cast'}
        ref={bindScroller}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard access to the horizontal cast rail.
        tabIndex={0}
        style={edgeMask ? { maskImage: edgeMask, WebkitMaskImage: edgeMask } : undefined}
        {...dragScrollProps}
        className={cn(
          '-mx-1 flex gap-4 overflow-x-auto overscroll-x-contain scrollbar-hide px-1 pt-1 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/25',
          scrollState.hasOverflow && DRAG_SCROLL_CLASS,
        )}
      >
        {people.map((person) => (
          <li
            key={`${person.name}:${person.character ?? ''}:${person.voiceActor ?? ''}:${person.role}`}
            className='group/person w-32 shrink-0 space-y-2.5 sm:w-36'
          >
            <div className='relative aspect-[3/4] overflow-hidden rounded-lg bg-white/[0.045]'>
              <span
                aria-hidden='true'
                className='absolute inset-0 flex items-center justify-center text-2xl font-medium text-white/25'
              >
                {person.name
                  .split(/\s+/)
                  .slice(0, 2)
                  .map((word) => Array.from(word)[0])
                  .join('')
                  .toLocaleUpperCase()}
              </span>
              {person.imageUrl && (
                <RemoteImage
                  src={person.imageUrl}
                  alt=''
                  loading='lazy'
                  fadeIn
                  className='absolute inset-0 size-full object-cover object-top'
                />
              )}
              <span
                aria-hidden='true'
                className='pointer-events-none absolute inset-0 z-10 rounded-lg bg-black/0 ring-1 ring-inset ring-white/[0.08] transition-[background-color,box-shadow] duration-200 ease-out group-hover/person:bg-black/15 group-hover/person:ring-white/20 motion-reduce:transition-none'
              />
              <span
                aria-hidden='true'
                className='pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-linear-to-t from-black/35 to-transparent'
              />
            </div>
            <div className='min-w-0 space-y-0.5 px-0.5 text-[13px] leading-5'>
              <p
                title={person.name}
                className='line-clamp-2 break-words font-medium text-white/85 transition-colors duration-150 group-hover/person:text-white motion-reduce:transition-none'
              >
                {characters ? person.name : <CreditLink name={person.name} />}
              </p>
              {person.character && (
                <p className='line-clamp-2 break-words text-[12px] text-white/60'>
                  as {person.character}
                </p>
              )}
              {person.voiceActor && (
                <p className='line-clamp-2 break-words text-[12px] text-white/60'>
                  <span className='text-white/45'>Voiced by </span>
                  <CreditLink name={person.voiceActor} />
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const SECTION_HEADING_CLASS =
  'mb-3 text-xl font-semibold leading-7 tracking-[-0.02em] text-zinc-100';

export function DetailsSections({
  item,
  credits,
  hasEpisodes,
  allowExtras,
  children,
}: {
  item: MediaDetails;
  credits?: TitleCredits;
  hasEpisodes: boolean;
  allowExtras: boolean;
  children?: ReactNode;
}) {
  if (item.type === 'movie') return null;
  const data = allowExtras ? credits : undefined;
  const people = data?.people ?? [];
  const characters = data?.source === 'anilist';
  if (!hasEpisodes && !people.length) return null;
  return (
    <div className='min-w-0 space-y-9'>
      {hasEpisodes && (
        <section aria-labelledby='details-episodes-heading' className='min-w-0'>
          <h2
            id='details-episodes-heading'
            tabIndex={-1}
            className={cn(SECTION_HEADING_CLASS, 'focus:outline-hidden')}
          >
            Episodes
          </h2>
          {children}
        </section>
      )}
      {people.length > 0 && (
        <section aria-labelledby='details-cast-heading' className='min-w-0'>
          <People people={people} characters={characters} />
        </section>
      )}
      {data?.source && (
        <p className='flex flex-wrap gap-x-1 text-[12px] leading-5 text-white/45'>
          Data:
          {data.source === 'tvmaze' ? (
            <>
              <ExternalLink item={item} href='https://www.tvmaze.com' className={SOURCE_LINK_CLASS}>
                TVmaze
              </ExternalLink>
              <span aria-hidden='true'>&middot;</span>
              <ExternalLink
                item={item}
                href='https://creativecommons.org/licenses/by-sa/4.0/'
                className={SOURCE_LINK_CLASS}
              >
                CC BY-SA
              </ExternalLink>
            </>
          ) : (
            <ExternalLink item={item} href='https://anilist.co' className={SOURCE_LINK_CLASS}>
              AniList
            </ExternalLink>
          )}
        </p>
      )}
    </div>
  );
}

const AIRING_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function NextAiringChip({ episode }: { episode: NextAiringEpisode }) {
  const deadline = episode.airingAt * 1000;
  const [expired, setExpired] = useState(
    () => !Number.isFinite(deadline) || deadline <= Date.now(),
  );
  useEffect(() => {
    if (expired) return;
    let timer: ReturnType<typeof setTimeout>;
    const expire = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) setExpired(true);
      else timer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
    };
    expire();
    return () => clearTimeout(timer);
  }, [deadline, expired]);
  if (expired) return null;
  const date = new Date(deadline);
  return (
    <span className='inline-flex min-w-0 max-w-full flex-wrap items-center gap-x-2.5 gap-y-1 rounded-md bg-white/[0.045] px-2.5 py-1.5 text-[13px] leading-5'>
      <span className='inline-flex items-center gap-1.5 font-medium text-zinc-200'>
        <CalendarClock aria-hidden='true' className='h-3.5 w-3.5 shrink-0 text-zinc-400' />
        Next: Episode {episode.episode}
      </span>
      <time dateTime={date.toISOString()} className='tabular-nums text-zinc-300'>
        {AIRING_DATE_FORMAT.format(date)}
      </time>
    </span>
  );
}
