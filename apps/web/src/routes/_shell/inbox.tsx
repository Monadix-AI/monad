import { createFileRoute } from '@tanstack/react-router';

import { InboxRoute } from '#/features/inbox/InboxRoute';

export const Route = createFileRoute('/_shell/inbox')({
  component: InboxRoute
});
