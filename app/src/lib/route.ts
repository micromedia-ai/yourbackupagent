import { useEffect, useState } from 'react';

export function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const f = () => setPath(location.pathname);
    window.addEventListener('popstate', f);
    return () => window.removeEventListener('popstate', f);
  }, []);
  return path;
}

export function go(path: string) {
  if (path !== location.pathname) history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo(0, 0);
}

export function link(path: string) {
  return {
    href: path,
    onClick: (e: React.MouseEvent) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      go(path);
    },
  };
}
