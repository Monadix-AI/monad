import type { createDaemonHandlers } from '@/handlers/daemon-handlers/index.ts';

import { daemonHttpContract } from '@monad/protocol';
import { Elysia } from 'elysia';

export function createHealthController(handlers: ReturnType<typeof createDaemonHandlers>) {
  // Intentionally unversioned — liveness probes (k8s, load balancers, CLI ping) need a stable
  // URL that survives API version bumps. All other endpoints live under /v1/*.
  return new Elysia().get('/health', async () => handlers.health(), {
    response: daemonHttpContract.health.get.response,
    detail: {
      summary: 'Daemon health check',
      description: 'Returns service status and daemon version.'
    }
  });
}
