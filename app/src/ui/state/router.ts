import { useCallback, useEffect, useState } from 'react';

/** Hash routes: `#/home`, `#/programs/alpha_eyes_closed`, `#/history/s_...`. */
export function parseHash(hash: string): string[] {
  return hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
}

export function useRoute(): { path: string[]; navigate: (to: string) => void } {
  const [hash, setHash] = useState(() => (typeof window === 'undefined' ? '' : window.location.hash));
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const navigate = useCallback((to: string) => {
    window.location.hash = to.startsWith('#') ? to : `#/${to.replace(/^\//, '')}`;
  }, []);
  return { path: parseHash(hash), navigate };
}
