import { useEffect, useRef } from 'react';

const APP_TITLE = 'Stremiro';

/**
 * `document.title` feeds the OS taskbar tooltip and accessibility tree even
 * though the frameless window never shows it. Falsy resets to the app title
 * and unmount restores it — unless a co-mounted writer (e.g. a docked player)
 * has taken the title since.
 */
export function useDocumentTitle(title?: string | null) {
  const appliedTitleRef = useRef<string | null>(null);
  useEffect(() => {
    const next = title ? `${title} — ${APP_TITLE}` : APP_TITLE;
    document.title = next;
    appliedTitleRef.current = next;
    return () => {
      // Only restore when this instance's write is still live — a later
      // writer owns the title otherwise.
      if (document.title === appliedTitleRef.current) {
        document.title = APP_TITLE;
      }
    };
  }, [title]);
}
