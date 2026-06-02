import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';
import type { NativeAgentAttachmentResolver } from './attachments.ts';

import { createNativeAgentApiRegistry } from './capabilities.ts';
import { createNativeAgentDirectApi } from './direct.ts';
import { createNativeAgentProjectApi } from './project.ts';
import { createNativeAgentProjectPlanApi } from './project-plan.ts';

export function createDefaultNativeAgentApi(
  handlers: ReturnType<typeof createDaemonHandlers>,
  resolveAttachmentPayload: NativeAgentAttachmentResolver
) {
  const registry = createNativeAgentApiRegistry();
  registry.registerProject(createNativeAgentProjectApi(handlers, resolveAttachmentPayload));
  registry.registerDirect(createNativeAgentDirectApi(handlers, resolveAttachmentPayload));
  registry.registerPlan(createNativeAgentProjectPlanApi(handlers));
  return registry.resolve();
}
