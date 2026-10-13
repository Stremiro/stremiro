import { useEffect } from 'react';

const APP_TITLE = 'Stremiro';

/** Sets document.title (feeds OS taskbar/a11y despite the frameless window); restores the app title on unmount unless a later writer owns it. */
export function useDocumentTitle(title?: string | null) {
  useEffect(() => {
    const next = title ? `${title} — ${APP_TITLE}` : APP_TITLE;
    document.title = next;
    return () => {
      // Only restore if this write is still live — a later writer owns the title otherwise.
      if (document.title === next) {
        document.title = APP_TITLE;
      }
    };
  }, [title]);
}
