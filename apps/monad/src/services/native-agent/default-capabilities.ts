import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';
import type { NativeAgentAttachmentResolver } from './attachments.ts';

import { createNativeAgentCapabilityRegistry } from './capabilities.ts';
import { createNativeAgentDirectCapabilities } from './direct.ts';
import { createNativeAgentProjectCapabilities } from './project.ts';

export function createDefaultNativeAgentCapabilities(
  handlers: ReturnType<typeof createDaemonHandlers>,
  resolveAttachmentPayload: NativeAgentAttachmentResolver
) {
  const registry = createNativeAgentCapabilityRegistry();
  registry.registerProject(createNativeAgentProjectCapabilities(handlers, resolveAttachmentPayload));
  registry.registerDirect(createNativeAgentDirectCapabilities(handlers, resolveAttachmentPayload));
  return registry.resolve();
}
