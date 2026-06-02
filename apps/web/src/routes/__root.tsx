import { createRootRoute, HeadContent, Outlet } from '@tanstack/react-router';
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools';

import { AppProviders } from '#/components/AppProviders';

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        title: 'Monad'
      },
      {
        content: '',
        name: 'description'
      }
    ]
  }),
  component: RootRoute
});

// The devtools panel's collapsed toggle is a fixed bottom-left pill that physically overlaps the
// app's own bottom-left daemon menu button (same corner, same viewport position). Playwright's
// webServer sets this flag so e2e runs — which serve the real dev build, not a production one —
// don't fight the app's own controls for that corner. Real dev sessions are unaffected.
const showRouterDevtools = import.meta.env.VITE_PLAYWRIGHT_TEST !== '1';

function RootRoute() {
  return (
    <>
      <HeadContent />
      <AppProviders>
        <Outlet />
      </AppProviders>
      {showRouterDevtools && <TanStackRouterDevtools position="bottom-left" />}
    </>
  );
}
