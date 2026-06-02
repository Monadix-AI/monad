import {
  httpErrorSchema,
  mcpAppCapabilityRequestSchema,
  mcpAppCapabilityResponseSchema,
  mcpAppCapabilityRevokeResponseSchema,
  mcpAppRpcRequestSchema,
  mcpAppRpcResponseSchema,
  mcpAppViewRequestSchema,
  mcpAppViewResponseSchema
} from '@monad/protocol';
import { Elysia } from 'elysia';
import { z } from 'zod';

import {
  invokeMcpAppBridge,
  issueMcpAppCapability,
  McpAppBridgeError,
  revokeMcpAppCapability,
  waitForMcpAppView
} from '#/capabilities/tools/registry/mcp/app-bridge.ts';

export function createMcpAppController() {
  return new Elysia({ tags: ['http-only'] })
    .post(
      '/mcp-apps/capabilities',
      ({ body, set }) => {
        try {
          return issueMcpAppCapability(body.bridgeId, body.sessionId, body.revision);
        } catch (error) {
          if (!(error instanceof McpAppBridgeError)) throw error;
          set.status = error.status;
          return { error: error.message, code: 'MCP_APP_BRIDGE' };
        }
      },
      {
        body: mcpAppCapabilityRequestSchema,
        response: {
          200: mcpAppCapabilityResponseSchema,
          403: httpErrorSchema,
          404: httpErrorSchema,
          410: httpErrorSchema
        },
        detail: {
          summary: 'Issue an MCP App capability',
          description: 'Mints a short-lived capability for a session-bound MCP App bridge.'
        }
      }
    )
    .post(
      '/mcp-apps/views',
      async ({ body, request, set }) => {
        try {
          return await waitForMcpAppView(body.bridgeId, body.sessionId, body.afterRevision, request.signal);
        } catch (error) {
          if (!(error instanceof McpAppBridgeError)) throw error;
          set.status = error.status;
          return { error: error.message, code: 'MCP_APP_BRIDGE' };
        }
      },
      {
        body: mcpAppViewRequestSchema,
        response: {
          200: mcpAppViewResponseSchema,
          403: httpErrorSchema,
          404: httpErrorSchema,
          410: httpErrorSchema,
          429: httpErrorSchema
        },
        detail: {
          summary: 'Wait for an MCP App view',
          description: 'Returns the current view when its template revision changes.'
        }
      }
    )
    .post(
      '/mcp-apps/:token/rpc',
      async ({ body, params, request, set }) => {
        try {
          return { result: await invokeMcpAppBridge(params.token, body, request.signal) };
        } catch (error) {
          if (!(error instanceof McpAppBridgeError)) throw error;
          set.status = error.status;
          return { error: error.message, code: 'MCP_APP_BRIDGE' };
        }
      },
      {
        params: z.object({
          token: z
            .string()
            .length(64)
            .regex(/^[a-f0-9]+$/)
        }),
        body: mcpAppRpcRequestSchema,
        response: {
          200: mcpAppRpcResponseSchema,
          400: httpErrorSchema,
          403: httpErrorSchema,
          404: httpErrorSchema,
          410: httpErrorSchema,
          413: httpErrorSchema,
          429: httpErrorSchema
        },
        detail: {
          summary: 'Invoke an MCP App capability',
          description: 'Uses a short-lived, server-bound capability minted for one rendered MCP App.'
        }
      }
    )
    .delete('/mcp-apps/:token/capability', ({ params }) => ({ revoked: revokeMcpAppCapability(params.token) }), {
      params: z.object({
        token: z
          .string()
          .length(64)
          .regex(/^[a-f0-9]+$/)
      }),
      response: { 200: mcpAppCapabilityRevokeResponseSchema },
      detail: {
        summary: 'Revoke an MCP App capability',
        description: 'Revokes a capability when its rendered MCP App is torn down.'
      }
    });
}
