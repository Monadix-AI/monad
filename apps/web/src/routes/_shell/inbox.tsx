import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/_shell/inbox')({
  component: Outlet
});
