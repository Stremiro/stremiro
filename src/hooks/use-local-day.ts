import { addDays, startOfDay } from 'date-fns';
import { useEffect, useState } from 'react';

export function useLocalDay(): Date {
  const [day, setDay] = useState(() => startOfDay(new Date()));

  useEffect(() => {
    let timer = 0;
    const updateDay = () => {
      const next = startOfDay(new Date());
      setDay((previous) => (previous.getTime() === next.getTime() ? previous : next));
    };
    const scheduleMidnight = () => {
      timer = window.setTimeout(
        () => {
          updateDay();
          scheduleMidnight();
        },
        startOfDay(addDays(new Date(), 1)).getTime() - Date.now(),
      );
    };
    const onReturnToView = () => {
      if (document.visibilityState !== 'visible') return;
      window.clearTimeout(timer);
      updateDay();
      scheduleMidnight();
    };
    scheduleMidnight();
    document.addEventListener('visibilitychange', onReturnToView);
    window.addEventListener('focus', onReturnToView);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onReturnToView);
      window.removeEventListener('focus', onReturnToView);
    };
  }, []);

  return day;
}
