import type { AgentCard } from '@a2a-js/sdk';
import type { Agent } from '@monad/protocol';

import { a2aJsonRpcPath } from '@monad/protocol';

const A2A_PROTOCOL_VERSION = '0.3.0';

/** Build the A2A AgentCard for a monad agent. `baseUrl` is the daemon's externally-reachable
 *  origin (scheme + host[:port]) as seen by the caller — derived from the request Host so the
 *  advertised URL matches however the client actually reached us. */
export function buildAgentCard(agent: Agent, baseUrl: string): AgentCard {
  const jsonRpcUrl = `${baseUrl}${a2aJsonRpcPath(agent.id)}`;
  return {
    name: agent.name,
    description: agent.description ?? `Monad agent ${agent.name}`,
    protocolVersion: A2A_PROTOCOL_VERSION,
    version: '1.0.0',
    url: jsonRpcUrl,
    preferredTransport: 'JSONRPC',
    skills: [
      {
        id: 'chat',
        name: 'Chat',
        description: 'Send a message and receive the agent’s reply.',
        tags: ['chat', 'text']
      }
    ],
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    additionalInterfaces: [{ url: jsonRpcUrl, transport: 'JSONRPC' }]
  };
}
