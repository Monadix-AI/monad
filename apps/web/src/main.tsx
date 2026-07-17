import { createRouter, RouterProvider } from '@tanstack/react-router';
import React from 'react';
import { createRoot } from 'react-dom/client';

import { setShellRouter } from './hooks/use-shell-location';
import { installPreloadErrorRecovery } from './lib/preload-error-recovery';
import { routeTree } from './routeTree.gen';

installPreloadErrorRecovery();

const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  defaultStructuralSharing: true,
  scrollRestoration: true
});

setShellRouter(router);

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);
