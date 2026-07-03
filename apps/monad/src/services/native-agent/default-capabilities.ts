import type { createDaemonHandlers } from '@/handlers/handlers.ts';
import type { NativeAgentAttachmentResolver } from './attachments.ts';

import { createChatRoomNativeAgentProjectCapabilities } from '@/services/chatroom/native-agent-project.ts';
import { createNativeAgentCapabilityRegistry } from './capabilities.ts';
import { createNativeAgentDirectCapabilities } from './direct.ts';

export function createDefaultNativeAgentCapabilities(
  handlers: ReturnType<typeof createDaemonHandlers>,
  resolveAttachmentPayload: NativeAgentAttachmentResolver
) {
  const registry = createNativeAgentCapabilityRegistry();
  registry.registerProject(createChatRoomNativeAgentProjectCapabilities(handlers, resolveAttachmentPayload));
  registry.registerDirect(createNativeAgentDirectCapabilities(handlers, resolveAttachmentPayload));
  return registry.resolve();
}
