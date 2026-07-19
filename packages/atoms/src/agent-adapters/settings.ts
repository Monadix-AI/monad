import type { MeshAgentAppServerTransport, MeshAgentLaunchMode, MeshAgentSetting } from '@monad/protocol';

export function meshAgentAdapterSettings(options: {
  launchModes: MeshAgentLaunchMode[];
  appServerTransports?: MeshAgentAppServerTransport[];
}): MeshAgentSetting[] {
  return [
    {
      key: 'defaultLaunchMode',
      label: 'Launch mode',
      kind: 'select',
      options: options.launchModes.map((value) => ({ value, label: value }))
    },
    {
      key: 'allowAutopilot',
      label: 'Autopilot',
      description: 'Let the provider run unattended when supported.',
      kind: 'switch'
    },
    ...(options.appServerTransports?.length
      ? [
          {
            key: 'appServerTransport',
            label: 'App-server transport',
            kind: 'select' as const,
            placeholder: 'Default',
            options: options.appServerTransports.map((value) => ({ value, label: value }))
          }
        ]
      : [])
  ];
}
