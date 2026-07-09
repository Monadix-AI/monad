import { createFileRoute } from '@tanstack/react-router';

import { Settings } from '#/features/settings/Settings';
import { normalizeSettingsSection } from '#/features/settings/sections';
import { useShellRouteContext } from '#/features/shell/page-shell/ShellRouteProvider';

export const Route = createFileRoute('/_shell/settings/$section')({
  component: SettingsRouteComponent
});

function SettingsRouteComponent() {
  const { section } = Route.useParams();
  const { settingsRouteProps } = useShellRouteContext();
  return (
    <Settings
      {...settingsRouteProps}
      initialSection={normalizeSettingsSection(section)}
    />
  );
}
