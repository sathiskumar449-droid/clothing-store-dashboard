import { useEffect, useRef } from 'react';

/**
 * Calls `fetchFn` immediately and then every `intervalMs` milliseconds.
 * Clears the interval on unmount or when deps change.
 */
export function useAutoRefresh(fetchFn, intervalMs = 8000, deps = []) {
  const savedFn = useRef(fetchFn);

  useEffect(() => {
    savedFn.current = fetchFn;
  }, [fetchFn]);

  useEffect(() => {
    savedFn.current();
    const id = setInterval(() => savedFn.current(), intervalMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, ...deps]);
}
