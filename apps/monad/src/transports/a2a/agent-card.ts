import type { AgentCard } from '@a2a-js/sdk';
import type { Agent } from '@monad/protocol';

import { A2A_PROTOCOL_VERSION } from '@a2a-js/sdk';
import { a2aJsonRpcPath } from '@monad/protocol';

/** Build the A2A AgentCard for a monad agent. `baseUrl` is the daemon's externally-reachable
 *  origin (scheme + host[:port]) as seen by the caller — derived from the request Host so the
 *  advertised URL matches however the client actually reached us. */
export function buildAgentCard(agent: Agent, baseUrl: string): AgentCard {
  const jsonRpcUrl = `${baseUrl}${a2aJsonRpcPath(agent.id)}`;
  return {
    name: agent.name,
    description: `Monad agent ${agent.name}`,
    supportedInterfaces: [
      {
        url: jsonRpcUrl,
        protocolBinding: 'JSONRPC',
        protocolVersion: A2A_PROTOCOL_VERSION,
        tenant: ''
      }
    ],
    provider: undefined,
    version: '1.0.0',
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: [],
      extendedAgentCard: false
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      {
        id: 'chat',
        name: 'Chat',
        description: 'Send a message and receive the agent’s reply.',
        tags: ['chat', 'text'],
        examples: [],
        inputModes: ['text/plain'],
        outputModes: ['text/plain'],
        securityRequirements: []
      }
    ],
    signatures: []
  };
}
