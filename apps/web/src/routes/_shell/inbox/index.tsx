import { createFileRoute, redirect } from '@tanstack/react-router';

import { DEFAULT_INBOX_FILTER } from '#/features/shell/routing/paths';

export const Route = createFileRoute('/_shell/inbox/')({
  beforeLoad: () => {
    throw redirect({ params: { filter: DEFAULT_INBOX_FILTER }, to: '/inbox/$filter' });
  }
});
