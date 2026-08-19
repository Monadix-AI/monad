import type { MeshAgentSetting } from '@monad/protocol';

/** Settings shared by adapters that explicitly opt into the built-in runtime controls. */
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
