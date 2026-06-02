import { inboxFilterSchema } from '@monad/protocol';
import { createFileRoute, Navigate } from '@tanstack/react-router';

import { InboxRoute } from '#/features/inbox/InboxRoute';
import { DEFAULT_INBOX_FILTER } from '#/features/shell/routing/paths';

export const Route = createFileRoute('/_shell/inbox/$filter')({
  component: InboxFilterRoute
});

function InboxFilterRoute() {
  const { filter } = Route.useParams();
  const parsed = inboxFilterSchema.safeParse(filter);
  if (!parsed.success)
    return (
      <Navigate
        params={{ filter: DEFAULT_INBOX_FILTER }}
        replace
        to="/inbox/$filter"
      />
    );
  return <InboxRoute filter={parsed.data} />;
}
