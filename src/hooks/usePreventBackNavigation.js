import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

// The exam flow is forward-only. Every forward step navigates with
// `replace`, so no earlier step is left in the history stack; this hook
// additionally pins the current page against the browser's Back/Forward
// buttons (and history-menu jumps) by keeping a duplicate entry on top
// and restoring this page whenever a popstate moves away from it.
//
// This app uses a plain <BrowserRouter> (not a data router), so React
// Router's useBlocker isn't available — hence the history sentinel.
export function usePreventBackNavigation({ enabled = true, onBlocked } = {}) {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const onBlockedRef = useRef(onBlocked);
  onBlockedRef.current = onBlocked;

  useEffect(() => {
    if (!enabled) return undefined;
    const pinnedPath = `${pathname}${search}`;
    const pushSentinel = () => window.history.pushState(window.history.state, '', window.location.href);
    pushSentinel();

    const handlePopState = () => {
      // A jump of several entries can land on an earlier step's URL — put
      // the router back on this page before re-adding the sentinel.
      if (`${window.location.pathname}${window.location.search}` !== pinnedPath) {
        navigate(pinnedPath, { replace: true });
      }
      pushSentinel();
      onBlockedRef.current?.();
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [enabled, pathname, search, navigate]);
}
