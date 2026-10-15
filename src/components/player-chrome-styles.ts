export const CHROME_ICON_CLASS = 'h-[22px] w-[22px]';
export const CHROME_ICON_STROKE = 2.25;

/** One owner so top chrome, controls row, and selector triggers cannot drift. */
export const CHROME_ICON_BUTTON_CLASS =
  'flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white transition-colors hover:bg-white/12 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-35 disabled:pointer-events-none [&_svg]:drop-shadow-[0_1px_1px_rgba(0,0,0,0.45)]';

export const CHROME_PILL_CLASS =
  'flex min-h-12 shrink-0 items-center gap-0.5 rounded-full bg-zinc-950/75 p-1 ring-1 ring-white/[0.08] shadow-[0_8px_24px_-8px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-xl';

/** Glass surface for controls-row popovers (speed, audio, subtitles); callers add width and padding. */
export const CHROME_POPOVER_CLASS =
  'rounded-xl border-white/[0.08] bg-zinc-950/95 shadow-2xl shadow-black/60 backdrop-blur-xl';

/** Round close button for full-surface player overlays (shortcuts, episodes). */
export const CHROME_CLOSE_BUTTON_CLASS =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40';
