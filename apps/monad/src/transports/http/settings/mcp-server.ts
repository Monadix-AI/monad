import type { createDaemonHandlers } from '@/handlers/handlers.ts';

import {
  listMcpCatalogResponseSchema,
  listMcpServerStatusResponseSchema,
  listMcpServersResponseSchema,
  okResponseSchema,
  searchMcpRegistryResponseSchema,
  upsertMcpServerRequestSchema
} from '@monad/protocol';
import { Elysia } from 'elysia';
import { z } from 'zod';

// CRUD for the MCP-server registry (cfg.mcpServers) the daemon connects to. System config — edits
// persist to config.json and apply live via the configBus diff-reconnect (no restart). The /status
// route reports the LIVE connection health (connected/disabled/failed) across all sources.
// HTTP-only surface: contract declared inline; reusable wire schemas come from @monad/protocol.
const serverParams = z.object({ name: z.string() });

export function createMcpServerSettingsController(handlers: ReturnType<typeof createDaemonHandlers>) {
  return new Elysia({ tags: ['http-only'] })
    .get('/mcp-servers', async () => handlers.mcpServer.listMcpServers(), {
      response: { 200: listMcpServersResponseSchema },
      detail: { summary: 'List MCP servers', description: 'Returns the configured mcpServers registry.' }
    })
    .get('/mcp-servers/status', async () => handlers.mcpServer.listMcpServerStatus(), {
      response: { 200: listMcpServerStatusResponseSchema },
      detail: {
        summary: 'MCP server status',
        description: 'Live connection health (connected/disabled/failed + tools) across all sources.'
      }
    })
    .get('/mcp-servers/catalog', async () => handlers.mcpServer.listMcpCatalog(), {
      response: { 200: listMcpCatalogResponseSchema },
      detail: { summary: 'MCP catalog', description: 'Curated directory of popular MCP servers for one-click add.' }
    })
    .get('/mcp-servers/registry/search', async ({ query }) => handlers.mcpServer.searchMcpRegistry(query.q ?? ''), {
      query: z.object({ q: z.string().optional() }),
      response: { 200: searchMcpRegistryResponseSchema },
      detail: {
        summary: 'Search MCP registry',
        description: 'Search across Official MCP Registry, Glama, Smithery, and built-in catalog.'
      }
    })
    .put('/mcp-servers', async ({ body }) => handlers.mcpServer.upsertMcpServer(body), {
      body: upsertMcpServerRequestSchema,
      response: { 200: okResponseSchema },
      detail: { summary: 'Upsert MCP server', description: 'Creates or replaces a server by name.' }
    })
    .post(
      '/mcp-servers/:name/enable',
      async ({ params }) => handlers.mcpServer.setMcpServerEnabled({ name: params.name, enabled: true }),
      { params: serverParams, response: { 200: okResponseSchema }, detail: { summary: 'Enable server' } }
    )
    .post(
      '/mcp-servers/:name/disable',
      async ({ params }) => handlers.mcpServer.setMcpServerEnabled({ name: params.name, enabled: false }),
      { params: serverParams, response: { 200: okResponseSchema }, detail: { summary: 'Disable server' } }
    )
    .post(
      '/mcp-servers/:name/authorize',
      async ({ params }) => handlers.mcpServer.authorizeMcpServer({ name: params.name }),
      {
        params: serverParams,
        response: { 200: okResponseSchema },
        detail: {
          summary: 'Authorize (OAuth)',
          description:
            'Run the interactive OAuth flow for an http oauth server, then reconnect it. Blocks until complete.'
        }
      }
    )
    .post(
      '/mcp-servers/:name/reconnect',
      async ({ params }) => handlers.mcpServer.reconnectMcpServer({ name: params.name }),
      {
        params: serverParams,
        response: { 200: okResponseSchema },
        detail: { summary: 'Reconnect server', description: 'Force one server to (re)connect — retry a boot failure.' }
      }
    )
    .delete('/mcp-servers/:name', async ({ params }) => handlers.mcpServer.removeMcpServer({ name: params.name }), {
      params: serverParams,
      response: { 200: okResponseSchema },
      detail: { summary: 'Remove MCP server', description: 'Deletes a server from the registry.' }
    });
}
