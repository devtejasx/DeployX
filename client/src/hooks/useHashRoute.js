import { useCallback, useEffect, useState } from 'react';

// The selection lives in the URL hash so it survives reloads and can be
// linked:  #/projects/<projectId>[/deployments/<deploymentId>]
function parse(hash) {
  const match = /^#\/projects\/([0-9a-f-]{36})(?:\/deployments\/([0-9a-f-]{36}))?$/i.exec(hash);
  return { projectId: match?.[1] ?? null, deploymentId: match?.[2] ?? null };
}

export function useHashRoute() {
  const [route, setRoute] = useState(() => parse(window.location.hash));

  useEffect(() => {
    const onHashChange = () => setRoute(parse(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = useCallback((projectId, deploymentId = null) => {
    let hash = '';
    if (projectId) hash = `#/projects/${projectId}${deploymentId ? `/deployments/${deploymentId}` : ''}`;
    if (hash !== window.location.hash) window.location.hash = hash;
    setRoute({ projectId, deploymentId });
  }, []);

  return [route, navigate];
}
