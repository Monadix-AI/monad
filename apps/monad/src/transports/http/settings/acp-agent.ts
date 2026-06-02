import type { createDaemonHandlers } from '@/handlers/handlers.ts';

import {
  listAcpAgentPresetsResponseSchema,
  listAcpAgentsResponseSchema,
  okResponseSchema,
  upsertAcpAgentRequestSchema
} from '@monad/protocol';
import { Elysia } from 'elysia';
import { z } from 'zod';

// CRUD for the external-ACP-agent registry (cfg.acpAgents) the `agent_acp_delegate` tool delegates
// to. System config — edits persist to config.json and re-apply the delegate tool live (no restart).
//
// HTTP-only surface (no JSON-RPC twin), so the endpoint contract is declared inline here; only the
// reusable wire schemas are imported from @monad/protocol. enable/disable derive `enabled` from the
// path, so they take no body.
const agentParams = z.object({ name: z.string() });

export function createAcpAgentSettingsController(handlers: ReturnType<typeof createDaemonHandlers>) {
  return (
    new Elysia({ tags: ['http-only'] })
      .get('/acp-agents', async () => handlers.acpAgent.listAcpAgents(), {
        response: { 200: listAcpAgentsResponseSchema },
        detail: { summary: 'List external ACP agents', description: 'Returns the configured acpAgents registry.' }
      })
      // Static path declared before the `:name` routes so it can't be shadowed. Returns the turnkey
      // invite presets (Codex / Claude Code) with same-machine detection so the UI can one-click invite.
      .get('/acp-agents/presets', () => handlers.acpAgent.listAcpAgentPresets(), {
        response: { 200: listAcpAgentPresetsResponseSchema },
        detail: { summary: 'List invite presets', description: 'Built-in third-party agent presets + local detection.' }
      })
      .put('/acp-agents', async ({ body }) => handlers.acpAgent.upsertAcpAgent(body), {
        body: upsertAcpAgentRequestSchema,
        response: { 200: okResponseSchema },
        detail: { summary: 'Upsert external ACP agent', description: 'Creates or replaces an agent by name.' }
      })
      .post(
        '/acp-agents/:name/enable',
        async ({ params }) => handlers.acpAgent.setAcpAgentEnabled({ name: params.name, enabled: true }),
        { params: agentParams, response: { 200: okResponseSchema }, detail: { summary: 'Enable agent' } }
      )
      .post(
        '/acp-agents/:name/disable',
        async ({ params }) => handlers.acpAgent.setAcpAgentEnabled({ name: params.name, enabled: false }),
        { params: agentParams, response: { 200: okResponseSchema }, detail: { summary: 'Disable agent' } }
      )
      .delete('/acp-agents/:name', async ({ params }) => handlers.acpAgent.removeAcpAgent({ name: params.name }), {
        params: agentParams,
        response: { 200: okResponseSchema },
        detail: { summary: 'Remove external ACP agent', description: 'Deletes an agent from the registry.' }
      })
  );
}
