import type { Connector } from '@monad/sdk-atom';

import { webhookConnector } from './webhook.ts';

export const builtinConnectors: Connector[] = [webhookConnector];
