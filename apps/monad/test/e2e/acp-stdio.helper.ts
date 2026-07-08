// Spawned by acp-stdio.test.ts: a minimal ACP agent over real stdin/stdout, backed by the mock
// model. The test drives it via the SDK's client() API over the process pipes.

import { startAcpTransport } from '#/transports/acp/connection.ts';
import { buildHandlers, mockModel } from '../helpers.ts';

await startAcpTransport(buildHandlers(mockModel()));
