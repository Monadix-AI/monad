import type { Connector, ConnectorHost } from '@monad/sdk-atom';

export const webhookConnector: Connector = {
  name: 'webhook',
  scopes: [{ resource: 'net:listen' }],
  async start(_host: ConnectorHost): Promise<void> {},
  async stop(): Promise<void> {}
};
