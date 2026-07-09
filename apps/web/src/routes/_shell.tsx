import { createFileRoute, Outlet } from '@tanstack/react-router';

import { ShellRouteProvider } from '#/features/shell/page-shell/ShellRouteProvider';

export const Route = createFileRoute('/_shell')({
  component: ShellLayout
});

function ShellLayout() {
  return (
    <ShellRouteProvider>
      <Outlet />
    </ShellRouteProvider>
  );
}
