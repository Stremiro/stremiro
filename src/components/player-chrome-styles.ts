export const CHROME_ICON_CLASS = 'h-[22px] w-[22px]';
export const CHROME_ICON_STROKE = 2.25;

/** One owner so top chrome, controls row, and selector triggers cannot drift. */
export const CHROME_ICON_BUTTON_CLASS =
  'flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-lg text-white transition-colors hover:bg-white/12 aria-expanded:bg-white/15 aria-expanded:hover:bg-white/15 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-35 disabled:pointer-events-none motion-reduce:transition-none motion-reduce:active:scale-100 [&_svg]:drop-shadow-[0_1px_1px_rgba(0,0,0,0.45)]';

/** Chrome reveal: a quick decelerating entrance and a slightly longer exit, so hiding reads as a dissolve, not a cut. */
export const CHROME_ENTER_TIMING_CLASS = 'duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]';
export const CHROME_EXIT_TIMING_CLASS = 'duration-[420ms] ease-[cubic-bezier(0.4,0,0.2,1)]';

export const CHROME_PILL_CLASS =
  'flex min-h-12 shrink-0 items-center gap-0.5 rounded-xl border border-white/[0.08] bg-zinc-950/72 p-1 shadow-[inset_0_1px_0_rgb(255_255_255/0.07)] backdrop-blur-xl';

/** Title-row controls. Same hit size as the transport icons, with a surface that reads on the picture. */
export const CHROME_CORNER_BUTTON_CLASS =
  'flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-[10px] border border-white/[0.08] bg-black/30 text-white/85 transition-colors duration-150 hover:border-white/15 hover:bg-black/55 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 active:bg-black/70 motion-reduce:transition-none';

export const CHROME_SKIP_BUTTON_CLASS =
  'border border-white/[0.12] bg-zinc-950/80 text-white/95 shadow-[0_10px_24px_-14px_rgb(0_0_0/0.8),inset_0_1px_0_rgb(255_255_255/0.08)] backdrop-blur-md transition-colors duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] hover:border-white/20 hover:bg-zinc-900/90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-(--accent-skip)/60 motion-reduce:transition-none';

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
