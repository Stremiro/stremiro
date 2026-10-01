/** Shared player-chrome icon button — 36px muted-until-hover transport
    control. One owner so top chrome, controls row, and selector triggers
    cannot drift. */
export const CHROME_ICON_BUTTON_CLASS =
  'flex h-9 w-9 items-center justify-center rounded-lg text-white/80 transition-colors hover:bg-white/10 hover:text-white active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40';

/** Glass surface for controls-row popovers (speed, audio, subtitles); callers add width and padding. */
export const CHROME_POPOVER_CLASS =
  'rounded-xl border-white/[0.08] bg-zinc-950/95 shadow-2xl shadow-black/60 backdrop-blur-xl';

/** Round close button for full-surface player overlays (shortcuts, episodes). */
export const CHROME_CLOSE_BUTTON_CLASS =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40';
