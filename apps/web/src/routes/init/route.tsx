import { createFileRoute } from '@tanstack/react-router';

import { InitRoute } from '#/features/init/InitRoute';

export const Route = createFileRoute('/init')({
  component: InitRoute
});
