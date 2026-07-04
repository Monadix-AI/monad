// Connector authoring surface — the `connector` atom of the unified atom pack SDK.

import type { Scope } from '@monad/protocol';

export type { Scope };

export interface ConnectorHost {
  ingest(input: { sessionId?: string; text: string }): Promise<{ sessionId: string }>;
}

export interface Connector {
  name: string;
  scopes: Scope[];
  start(host: ConnectorHost): Promise<void>;
  stop(): Promise<void>;
}
