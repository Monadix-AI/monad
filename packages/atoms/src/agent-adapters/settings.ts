import type { MeshAgentSetting } from '@monad/protocol';

export function meshAgentAdapterSettings(): MeshAgentSetting[] {
  return [
    {
      key: 'allowAutopilot',
      label: 'Autopilot',
      description: 'Let the provider run unattended when supported.',
      kind: 'switch'
    }
  ];
}
