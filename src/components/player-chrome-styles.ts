export const CHROME_ICON_CLASS = 'h-[22px] w-[22px]';
export const CHROME_ICON_STROKE = 2.25;

/** One owner so top chrome, controls row, and selector triggers cannot drift. */
export const CHROME_ICON_BUTTON_CLASS =
  'flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full text-white transition-colors hover:bg-white/12 aria-expanded:bg-white/15 aria-expanded:hover:bg-white/15 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-35 disabled:pointer-events-none motion-reduce:transition-none motion-reduce:active:scale-100 [&_svg]:drop-shadow-[0_1px_1px_rgba(0,0,0,0.45)]';

/** Chrome reveal: a quick decelerating entrance and a slightly longer exit, so hiding reads as a dissolve, not a cut. */
export const CHROME_ENTER_TIMING_CLASS = 'duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]';
export const CHROME_EXIT_TIMING_CLASS = 'duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]';

export const CHROME_PILL_CLASS =
  'flex min-h-12 shrink-0 items-center gap-0.5 rounded-full bg-zinc-950/75 p-1 ring-1 ring-white/[0.08] shadow-[0_8px_24px_-8px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-xl';

export const CHROME_SKIP_BUTTON_CLASS =
  'rounded-full border border-[rgb(var(--accent-skip-rgb)/0.45)] bg-zinc-950/60 text-white/90 shadow-[0_4px_16px_-4px_rgb(0_0_0/0.5),inset_0_1px_0_rgb(255_255_255/0.08)] backdrop-blur-md transition-colors duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] hover:border-[rgb(var(--accent-skip-rgb)/0.65)] hover:bg-zinc-950/70 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-(--accent-skip)/60 motion-reduce:transition-none';

/** Glass surface for controls-row popovers (speed, audio, subtitles); callers add width and padding. */
export const CHROME_POPOVER_CLASS =
  // Exit stays instant: a fading layer over the video would swallow the next click.
  'rounded-xl border-white/[0.08] bg-zinc-950/95 shadow-2xl shadow-black/60 backdrop-blur-xl data-[state=open]:duration-150 data-[state=closed]:animate-none! motion-reduce:animate-none! motion-reduce:transition-none';

export const CHROME_MENU_ROW_FOCUS_CLASS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/40';

export const CHROME_MENU_INDICATOR_CLASS = 'flex h-3.5 w-3.5 shrink-0 items-center justify-center';

export const CHROME_VALUE_BUBBLE_CLASS =
  'whitespace-nowrap rounded-md bg-black/85 px-2 py-1 text-[12px] font-semibold leading-none tracking-tight tabular-nums text-white shadow-lg ring-1 ring-white/10';

/** Round close button for full-surface player overlays (shortcuts, episodes). */
export const CHROME_CLOSE_BUTTON_CLASS =
  'flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 motion-reduce:transition-none';
