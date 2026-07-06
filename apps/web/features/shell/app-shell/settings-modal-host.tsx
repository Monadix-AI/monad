'use client';

import { Settings } from '@/features/settings/Settings';
import { useNavigableModal } from '@/hooks/use-navigable-modal';

export function SettingsModalHost() {
  const [settingsTab, setSettingsTab] = useNavigableModal('settings');
  if (settingsTab === null) return null;
  return (
    <Settings
      initialSection={settingsTab}
      onClose={() => setSettingsTab(null)}
    />
  );
}
