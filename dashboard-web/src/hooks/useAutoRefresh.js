import { useEffect, useRef } from 'react';

/**
 * Calls `fetchFn` immediately (unless `immediate: false`) and then every `intervalMs`
 * milliseconds. Skips ticks while the tab is hidden/backgrounded (no point polling an API
 * the user isn't looking at) and catches up with one fetch as soon as the tab regains focus,
 * instead of waiting for the next interval tick. Clears everything on unmount or when deps change.
 */
export function useAutoRefresh(fetchFn, intervalMs = 8000, deps = [], { immediate = true } = {}) {
  const savedFn = useRef(fetchFn);

  useEffect(() => {
    savedFn.current = fetchFn;
  }, [fetchFn]);

  useEffect(() => {
    if (immediate) savedFn.current();

    const tick = () => {
      if (document.visibilityState === 'visible') savedFn.current();
    };
    const id = setInterval(tick, intervalMs);

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') savedFn.current();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, immediate, ...deps]);
}
