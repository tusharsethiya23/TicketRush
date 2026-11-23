import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Loads data with `load()` and keeps { data, error, loading }. With `intervalMs`, it
 * reloads on that interval while the tab is visible (FR-22 seat-map refresh).
 * `deps` restart it, like useEffect.
 */
export function useLoad(load, deps, { intervalMs } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(async () => {
    try {
      const data = await loadRef.current();
      setState({ data, error: null, loading: false });
      return data;
    } catch (error) {
      setState((s) => ({ ...s, error, loading: false }));
      return null;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    loadRef
      .current()
      .then((data) => alive && setState({ data, error: null, loading: false }))
      .catch((error) => alive && setState({ data: null, error, loading: false }));

    if (!intervalMs) return () => (alive = false);
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') reload();
    }, intervalMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { ...state, reload, setData: (data) => setState((s) => ({ ...s, data })) };
}
