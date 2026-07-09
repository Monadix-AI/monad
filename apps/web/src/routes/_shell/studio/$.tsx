import { createFileRoute } from '@tanstack/react-router';

import { useShellRouteContext } from '#/features/shell/page-shell/ShellRouteProvider';
import { StudioRouteLoading } from '#/features/studio/StudioLoading';
import { lazyComponent } from '#/lib/lazy-component';

// Studio is a self-contained sub-router: it reads its own section/detail from the URL,
// so a single splat route hosts every /studio/* path instead of per-section stub files.
const Studio = lazyComponent(() => import('#/features/studio/Studio').then((m) => m.Studio), StudioRouteLoading);

export const Route = createFileRoute('/_shell/studio/$')({
  component: StudioRouteComponent
});

function StudioRouteComponent() {
  const { onCloseStudio } = useShellRouteContext();
  return <Studio onClose={onCloseStudio} />;
}
