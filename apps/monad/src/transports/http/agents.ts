import type { createDaemonHandlers } from '@/handlers/handlers.ts';

import { daemonHttpContract } from '@monad/protocol';
import { Elysia } from 'elysia';

export function createAgentsController(handlers: ReturnType<typeof createDaemonHandlers>) {
  const contracts = daemonHttpContract.agents;

  return (
    new Elysia()
      .get('/agents', async () => handlers.agent.listAgents(), {
        response: contracts.list.response,
        detail: { summary: 'List agents', description: 'Returns all configured agents.' }
      })
      .post(
        '/agents',
        async ({ body, status, set }) => {
          const result = await handlers.agent.createAgent(body);
          set.headers.location = `/v1/agents/${result.agent.id}`;
          return status(201, result);
        },
        {
          body: contracts.create.body,
          response: contracts.create.response,
          detail: { summary: 'Create agent', description: 'Creates a new agent and persists it to config.' }
        }
      )
      // Elysia's radix trie gives static segments priority over dynamic ones — `/agents/default`
      // will never be captured by `/agents/:id` regardless of registration order.
      .get('/agents/default', async () => handlers.agent.getDefaultAgent(), {
        response: contracts.defaultGet.response,
        detail: { summary: 'Get default agent', description: 'Returns the current default agent id.' }
      })
      .put('/agents/default', async ({ body }) => handlers.agent.setDefaultAgent(body), {
        body: contracts.defaultSet.body,
        response: contracts.defaultSet.response,
        detail: { summary: 'Set default agent', description: 'Sets the default agent id.' }
      })
      .get('/agents/:id', async ({ params }) => handlers.agent.getAgent({ agentId: params.id }), {
        params: contracts.get.params,
        response: contracts.get.response,
        detail: { summary: 'Get agent', description: 'Returns one agent by id.' }
      })
      .patch('/agents/:id', async ({ params, body }) => handlers.agent.updateAgent({ agentId: params.id, ...body }), {
        params: contracts.update.params,
        body: contracts.update.body,
        response: contracts.update.response,
        detail: {
          summary: 'Update agent',
          description: 'Partially updates an agent (metadata, model, atoms, sandbox, visibility).'
        }
      })
      .delete('/agents/:id', async ({ params }) => handlers.agent.deleteAgent({ agentId: params.id }), {
        params: contracts.delete.params,
        response: contracts.delete.response,
        detail: { summary: 'Delete agent', description: 'Deletes an agent by id.' }
      })
      .get('/agents/:id/prompt', async ({ params }) => handlers.agent.getAgentPrompt({ agentId: params.id }), {
        params: contracts.promptGet.params,
        response: contracts.promptGet.response,
        detail: { summary: 'Get agent prompt', description: "Returns the agent's AGENT.md system-prompt body." }
      })
      .put(
        '/agents/:id/prompt',
        async ({ params, body }) => handlers.agent.setAgentPrompt({ agentId: params.id, prompt: body.prompt }),
        {
          params: contracts.promptSet.params,
          body: contracts.promptSet.body,
          response: contracts.promptSet.response,
          detail: { summary: 'Set agent prompt', description: "Writes the agent's AGENT.md system-prompt body." }
        }
      )
  );
}
