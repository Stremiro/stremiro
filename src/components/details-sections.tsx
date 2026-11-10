import {
  type ComponentProps,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { CreditLink } from '@/components/details-credits';
import { RemoteImage } from '@/components/remote-image';
import { scrollEdgeMask, useScrollEdgeIndicators } from '@/hooks/use-scroll-edge-indicators';
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

const PEOPLE_SCROLL_BUTTON_CLASS =
  'pointer-events-none absolute top-[38%] z-10 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-zinc-950/60 text-white/70 opacity-0 backdrop-blur-xs transition-opacity hover:bg-zinc-950/85 hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/people:pointer-events-auto group-hover/people:opacity-100 group-focus-within/people:pointer-events-auto group-focus-within/people:opacity-100 aria-disabled:pointer-events-none aria-disabled:opacity-0 motion-reduce:transition-none';

function People({ people, characters }: Pick<TitleCredits, 'people'> & { characters: boolean }) {
  const scrollRef = useRef<HTMLUListElement>(null);
  const dragRef = useRef<{ x: number; left: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const { bind: bindScroller, ...scrollState } = useScrollEdgeIndicators(scrollRef);
  const edgeMask = scrollEdgeMask(scrollState);

  const onPointerDown = (event: PointerEvent<HTMLUListElement>) => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    // Snap points fight a hand-held position; they resume on release and settle the rail.
    event.currentTarget.style.scrollSnapType = 'none';
    dragRef.current = { x: event.clientX, left: event.currentTarget.scrollLeft, moved: false };
  };
  const onPointerMove = (event: PointerEvent<HTMLUListElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (!drag.moved) {
      if (Math.abs(event.clientX - drag.x) < 4) return;
      drag.moved = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    event.currentTarget.scrollLeft = drag.left - (event.clientX - drag.x);
  };
  const endDrag = (event: PointerEvent<HTMLUListElement>) => {
    suppressClickRef.current = !!dragRef.current?.moved;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    event.currentTarget.style.scrollSnapType = '';
  };
  const scrollPeople = (direction: -1 | 1) => {
    scrollRef.current?.scrollBy({
      left: direction * scrollRef.current.clientWidth * 0.8,
      behavior: scrollBehavior(),
    });
  };
  return (
    <div className='group/people relative -mx-1'>
      <ul
        aria-label={characters ? 'Characters' : 'Cast'}
        ref={bindScroller}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard access to the horizontal cast rail.
        tabIndex={0}
        style={edgeMask ? { maskImage: edgeMask, WebkitMaskImage: edgeMask } : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClickCapture={(event) => {
          if (!suppressClickRef.current) return;
          suppressClickRef.current = false;
          event.preventDefault();
          event.stopPropagation();
        }}
        className='flex cursor-grab select-none gap-4 overflow-x-auto overscroll-x-contain snap-x snap-proximity scrollbar-hide px-1 pt-1 active:cursor-grabbing focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/25'
      >
        {people.map((person) => (
          <li
            key={`${person.name}:${person.character ?? ''}:${person.voiceActor ?? ''}:${person.role}`}
            className='w-32 shrink-0 snap-start space-y-2.5 sm:w-36'
          >
            <div className='relative aspect-[3/4] overflow-hidden rounded-lg bg-white/[0.045] ring-1 ring-inset ring-white/[0.07]'>
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
            </div>
            <div className='min-w-0 space-y-0.5 px-0.5 text-[13px] leading-5'>
              <p title={person.name} className='line-clamp-2 break-words font-medium text-white/85'>
                {characters ? person.name : <CreditLink name={person.name} />}
              </p>
              {person.character && (
                <p className='line-clamp-2 break-words text-[12px] text-white/45'>
                  as {person.character}
                </p>
              )}
              {person.voiceActor && (
                <p className='line-clamp-2 break-words text-[12px] text-white/45'>
                  <span className='text-white/35'>Voiced by </span>
                  <CreditLink name={person.voiceActor} />
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
      {scrollState.hasOverflow && (
        <>
          <button
            type='button'
            aria-label='Scroll cast left'
            aria-disabled={!scrollState.canScrollLeft || undefined}
            onClick={() => scrollPeople(-1)}
            className={cn(PEOPLE_SCROLL_BUTTON_CLASS, 'left-1')}
          >
            <ChevronLeft aria-hidden='true' className='h-4 w-4' />
          </button>
          <button
            type='button'
            aria-label='Scroll cast right'
            aria-disabled={!scrollState.canScrollRight || undefined}
            onClick={() => scrollPeople(1)}
            className={cn(PEOPLE_SCROLL_BUTTON_CLASS, 'right-1')}
          >
            <ChevronRight aria-hidden='true' className='h-4 w-4' />
          </button>
        </>
      )}
    </div>
  );
}

const SECTION_HEADING_CLASS = 'mb-3 text-[17px] font-semibold tracking-[-0.02em] text-white';

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
    <div className='min-w-0 space-y-6'>
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
          <h2 id='details-cast-heading' className={SECTION_HEADING_CLASS}>
            {characters ? 'Characters' : 'Cast'}
          </h2>
          <People people={people} characters={characters} />
        </section>
      )}
      {data?.source && (
        <p className='flex flex-wrap gap-x-1 text-[11px] leading-5 text-white/35'>
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
    <span className='inline-flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] text-white/65'>
      <span>Next: Episode {episode.episode}</span>
      <time dateTime={date.toISOString()}>{AIRING_DATE_FORMAT.format(date)}</time>
    </span>
  );
}
