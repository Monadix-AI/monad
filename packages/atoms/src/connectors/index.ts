import type { Connector, ConnectorHost } from '@monad/sdk-atom';

export type { Connector } from '@monad/sdk-atom';

export { verifyWebhookSignature } from './security.ts';

export const webhookConnector: Connector = {
  name: 'webhook',
  scopes: [{ resource: 'net:listen' }],
  async start(_host: ConnectorHost): Promise<void> {
    // placeholder: the daemon mounts POST /connectors/webhook and calls host.ingest(...).
    // When implemented, verify the request with verifyWebhookSignature({ secret, payload:
    // RAW body, signature: header }) BEFORE host.ingest(...) — a webhook URL is an
    // unauthenticated entry point — plus per-source rate limiting (createIpRateLimiter).
  },
  async stop(): Promise<void> {}
};

export const builtinConnectors: Connector[] = [webhookConnector];
