import { createRootRoute, HeadContent, Outlet } from '@tanstack/react-router';
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools';

import { AppProviders } from '#/components/AppProviders';

export const Route = createRootRoute({
  head: () => ({
    links: [
      {
        href: '/favicon.svg',
        rel: 'icon',
        type: 'image/svg+xml'
      },
      {
        href: '/favicon.ico',
        rel: 'icon',
        sizes: 'any'
      }
    ],
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

function RootRoute() {
  return (
    <>
      <HeadContent />
      <AppProviders>
        <Outlet />
      </AppProviders>
      <TanStackRouterDevtools position="bottom-left" />
    </>
  );
}
