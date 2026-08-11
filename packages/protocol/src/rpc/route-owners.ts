// Semantic-owner registries for the remaining non-Method, non-Stream, non-Presentation live routes —
// the resource / protocol-adapter / extension-gateway / development half of the P0-A binding catalog.
// Each route is explicitly cataloged so a newly mounted route that is not registered fails the
// binding-catalog conformance test (docs/internal/proposals/headless-runtime-mesh-engine-priorities.md). Each
// registry pins its owner at the type level (`as const satisfies readonly RuntimeBindingDef<'x'>[]`), so
// a mis-placed owner fails to compile; a runtime assertion in binding-catalog.test.ts double-locks it.
//
// Owners: `resource` (request/response reads and management writes with no JSON-RPC twin — settings,
// atoms, mesh CRUD, memory, inbox, skills, workplace, session sub-resources); `protocol-adapter`
// (foreign-protocol surfaces — OpenAI-compatible, A2A, MCP exposure, ACP, and the managed native-agent
// bridge); `extension-gateway` (the workspace-experience API gateway); `development` (developer-only
// settings and the developer-log SSE).

import type { RuntimeBindingDef } from './runtime-streams.ts';

export const PROTOCOL_ADAPTER_ROUTES = [
  { method: 'POST', template: '/a2a/agents/:agentId', owner: 'protocol-adapter', capability: 'runtime.adapter' },
  {
    method: 'GET',
    template: '/a2a/agents/:agentId/.well-known/agent-card.json',
    owner: 'protocol-adapter',
    capability: 'runtime.adapter'
  },
  { method: 'GET', template: '/openai/', owner: 'protocol-adapter', capability: 'runtime.adapter' },
  { method: 'POST', template: '/openai/v1/chat/completions', owner: 'protocol-adapter', capability: 'runtime.adapter' },
  { method: 'POST', template: '/openai/v1/embeddings', owner: 'protocol-adapter', capability: 'runtime.adapter' },
  { method: 'GET', template: '/openai/v1/models', owner: 'protocol-adapter', capability: 'runtime.adapter' },
  { method: 'GET', template: '/openai/v1/models/:id', owner: 'protocol-adapter', capability: 'runtime.adapter' },
  { method: 'POST', template: '/openai/v1/responses', owner: 'protocol-adapter', capability: 'runtime.adapter' },
  { method: 'DELETE', template: '/openai/v1/responses/:id', owner: 'protocol-adapter', capability: 'runtime.adapter' },
  { method: 'GET', template: '/openai/v1/responses/:id', owner: 'protocol-adapter', capability: 'runtime.adapter' },
  { method: 'GET', template: '/v1/agents/:id/a2a', owner: 'protocol-adapter', capability: 'runtime.adapter' },
  { method: 'POST', template: '/v1/agents/:id/mcp', owner: 'protocol-adapter', capability: 'runtime.adapter' },
  {
    method: 'POST',
    template: '/v1/internal/native-agent/agent/read',
    owner: 'protocol-adapter',
    capability: 'runtime.adapter'
  },
  {
    method: 'POST',
    template: '/v1/internal/native-agent/agent/send',
    owner: 'protocol-adapter',
    capability: 'runtime.adapter'
  },
  {
    method: 'POST',
    template: '/v1/internal/native-agent/project/ask',
    owner: 'protocol-adapter',
    capability: 'runtime.adapter'
  },
  {
    method: 'POST',
    template: '/v1/internal/native-agent/project/ask/cancel',
    owner: 'protocol-adapter',
    capability: 'runtime.adapter'
  },
  {
    method: 'POST',
    template: '/v1/internal/native-agent/project/inbox',
    owner: 'protocol-adapter',
    capability: 'runtime.adapter'
  },
  {
    method: 'POST',
    template: '/v1/internal/native-agent/project/inbox/ack',
    owner: 'protocol-adapter',
    capability: 'runtime.adapter'
  },
  {
    method: 'GET',
    template: '/v1/internal/native-agent/project/plan',
    owner: 'protocol-adapter',
    capability: 'runtime.adapter'
  },
  {
    method: 'POST',
    template: '/v1/internal/native-agent/project/plan/todos',
    owner: 'protocol-adapter',
    capability: 'runtime.adapter'
  },
  {
    method: 'POST',
    template: '/v1/internal/native-agent/project/plan/todos/delete',
    owner: 'protocol-adapter',
    capability: 'runtime.adapter'
  },
  {
    method: 'POST',
    template: '/v1/internal/native-agent/project/plan/todos/update',
    owner: 'protocol-adapter',
    capability: 'runtime.adapter'
  },
  {
    method: 'POST',
    template: '/v1/internal/native-agent/project/post',
    owner: 'protocol-adapter',
    capability: 'runtime.adapter'
  },
  {
    method: 'POST',
    template: '/v1/internal/native-agent/project/read',
    owner: 'protocol-adapter',
    capability: 'runtime.adapter'
  },
  {
    method: 'GET',
    template: '/v1/internal/native-agent/runtime/info',
    owner: 'protocol-adapter',
    capability: 'runtime.adapter'
  },
  {
    method: 'GET',
    template: '/v1/internal/native-agent/session/members',
    owner: 'protocol-adapter',
    capability: 'runtime.adapter'
  },
  { method: 'POST', template: '/v1/sessions/:id/acp/:agent', owner: 'protocol-adapter', capability: 'runtime.adapter' }
] as const satisfies readonly RuntimeBindingDef<'protocol-adapter'>[];

export const EXTENSION_GATEWAY_ROUTES = [
  {
    method: 'ALL',
    template: '/v1/atoms/workplace-experiences/:experienceId/api/*',
    owner: 'extension-gateway',
    capability: 'extension.gateway'
  }
] as const satisfies readonly RuntimeBindingDef<'extension-gateway'>[];

export const DEVELOPMENT_ROUTES = [
  { method: 'GET', template: '/v1/sessions/:id/logs', owner: 'development', capability: 'development' },
  { method: 'GET', template: '/v1/settings/developer', owner: 'development', capability: 'development' },
  { method: 'PUT', template: '/v1/settings/developer', owner: 'development', capability: 'development' },
  { method: 'DELETE', template: '/v1/settings/developer/logs', owner: 'development', capability: 'development' },
  { method: 'POST', template: '/v1/settings/developer/logs/preview', owner: 'development', capability: 'development' },
  {
    method: 'GET',
    template: '/v1/settings/developer/live-events',
    owner: 'development',
    capability: 'development'
  },
  {
    method: 'GET',
    template: '/v1/settings/developer/live-events/:meshSessionId/:observationEpoch',
    owner: 'development',
    capability: 'development'
  }
] as const satisfies readonly RuntimeBindingDef<'development'>[];

export const RESOURCE_ROUTES = [
  { method: 'GET', template: '/api/avatar-cache/:hash', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/api/avatar-cache/:hash', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/avatar-cache/:hash', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/avatar-cache/:hash', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/atoms', owner: 'resource', capability: 'runtime.resource' },
  { method: 'DELETE', template: '/v1/atoms/:name', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/atoms/:name', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/atoms/:name/assets/*', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/atoms/:name/disable', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/atoms/:name/enable', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/atoms/:name/update', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/atoms/:name/update', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/atoms/install', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/atoms/mcp', owner: 'resource', capability: 'runtime.resource' },
  { method: 'DELETE', template: '/v1/atoms/mcp/:name', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/atoms/mcp/:name', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/atoms/mcp/:name/disable', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/atoms/mcp/:name/enable', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/atoms/mcp/install', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/atoms/mcp/install-binary', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/atoms/pin', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/atoms/skills', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/atoms/skills', owner: 'resource', capability: 'runtime.resource' },
  { method: 'DELETE', template: '/v1/atoms/skills/:name', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/atoms/skills/:name', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/atoms/skills/:name/content', owner: 'resource', capability: 'runtime.resource' },
  { method: 'PUT', template: '/v1/atoms/skills/:name/content', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/atoms/skills/:name/update', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/atoms/skills/install', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/atoms/skills/local', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/atoms/skills/updates', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/atoms/skills/upload', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/atoms/skills/validate', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/atoms/workplace-experiences', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/attachments/:id', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/channels/:id/messages', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/daemon/stop', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/delegation/output', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/delegation/respond', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/draft-attachments/open', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/i18n/catalog', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/inbox/items', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/inbox/mentions', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/inbox/read', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/inbox/read-all', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/inbox/summary', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/inbox/unread', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/indexer/status', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/init/env-deps', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/init/env-deps', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/init/home', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/init/status', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/interactions', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/interactions/:id/cancel', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/interactions/:id/claim', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/interactions/:id/renew', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/mcp-apps/capabilities', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/mcp-apps/:token/rpc', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/interactions/:id/submit', owner: 'resource', capability: 'runtime.resource' },
  {
    method: 'POST',
    template: '/v1/interactions/presenters/:presenterId/release',
    owner: 'resource',
    capability: 'runtime.resource'
  },
  { method: 'POST', template: '/v1/mcp-apps/views', owner: 'resource', capability: 'runtime.resource' },
  {
    method: 'DELETE',
    template: '/v1/mcp-apps/:token/capability',
    owner: 'resource',
    capability: 'runtime.resource'
  },
  { method: 'GET', template: '/v1/licenses', owner: 'resource', capability: 'runtime.resource' },
  { method: 'PUT', template: '/v1/memory/backend', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/memory/backend/prepare', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/memory/core', owner: 'resource', capability: 'runtime.resource' },
  { method: 'PUT', template: '/v1/memory/core', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/memory/facts', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/memory/facts', owner: 'resource', capability: 'runtime.resource' },
  { method: 'DELETE', template: '/v1/memory/facts/:id', owner: 'resource', capability: 'runtime.resource' },
  { method: 'PATCH', template: '/v1/memory/facts/:id', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/memory/mem0', owner: 'resource', capability: 'runtime.resource' },
  { method: 'PUT', template: '/v1/memory/mem0/models', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/memory/status', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/mesh/agents', owner: 'resource', capability: 'runtime.resource' },
  { method: 'DELETE', template: '/v1/mesh/agents/:name', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/mesh/agents/:name', owner: 'resource', capability: 'runtime.resource' },
  { method: 'PUT', template: '/v1/mesh/agents/:name', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/mesh/agents/:name/disable', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/mesh/agents/:name/enable', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/mesh/agents/presets', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/mesh/agents/refresh', owner: 'resource', capability: 'runtime.resource' },
  {
    method: 'POST',
    template: '/v1/mesh/auth-sessions/:id/heartbeat',
    owner: 'resource',
    capability: 'runtime.resource'
  },
  { method: 'GET', template: '/v1/mesh/deliveries/:id', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/mesh/invitable-agents', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/mesh/runtimes', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/mesh/session-summaries', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/mesh/sessions/:id/connection', owner: 'resource', capability: 'runtime.resource' },
  {
    method: 'GET',
    template: '/v1/mesh/sessions/:id/events/convenience',
    owner: 'resource',
    capability: 'runtime.resource'
  },
  { method: 'GET', template: '/v1/mesh/sessions/:id/events/raw', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/projects/:id/sessions', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/projects/:id/sessions', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/sessions/:id/delegates', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/sessions/:id/members', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/sessions/:id/members', owner: 'resource', capability: 'runtime.resource' },
  {
    method: 'DELETE',
    template: '/v1/sessions/:id/members/:memberId',
    owner: 'resource',
    capability: 'runtime.resource'
  },
  { method: 'PUT', template: '/v1/sessions/:id/members/:memberId', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/sessions/:id/project-roster', owner: 'resource', capability: 'runtime.resource' },
  { method: 'PUT', template: '/v1/sessions/:id/runtime', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/sessions/:id/workspace-action', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/sessions/:id/workspace-git', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/sessions/:id/workspace-meta', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/settings/acp-agents', owner: 'resource', capability: 'runtime.resource' },
  { method: 'DELETE', template: '/v1/settings/acp-agents/:name', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/settings/acp-agents/:name', owner: 'resource', capability: 'runtime.resource' },
  { method: 'PUT', template: '/v1/settings/acp-agents/:name', owner: 'resource', capability: 'runtime.resource' },
  {
    method: 'POST',
    template: '/v1/settings/acp-agents/:name/disable',
    owner: 'resource',
    capability: 'runtime.resource'
  },
  {
    method: 'POST',
    template: '/v1/settings/acp-agents/:name/enable',
    owner: 'resource',
    capability: 'runtime.resource'
  },
  { method: 'GET', template: '/v1/settings/acp-agents/presets', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/settings/appearance', owner: 'resource', capability: 'runtime.resource' },
  { method: 'PUT', template: '/v1/settings/appearance', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/settings/browser-preset', owner: 'resource', capability: 'runtime.resource' },
  { method: 'PUT', template: '/v1/settings/browser-preset', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/settings/channels', owner: 'resource', capability: 'runtime.resource' },
  { method: 'DELETE', template: '/v1/settings/channels/:id', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/settings/channels/:id', owner: 'resource', capability: 'runtime.resource' },
  { method: 'PUT', template: '/v1/settings/channels/:id', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/settings/channels/:id/login', owner: 'resource', capability: 'runtime.resource' },
  {
    method: 'PUT',
    template: '/v1/settings/channels/:id/credential',
    owner: 'resource',
    capability: 'runtime.resource'
  },
  { method: 'POST', template: '/v1/settings/channels/:id/disable', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/settings/channels/:id/enable', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/settings/channels/status', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/settings/computer-preset', owner: 'resource', capability: 'runtime.resource' },
  { method: 'PUT', template: '/v1/settings/computer-preset', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/settings/credentials', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/settings/credentials', owner: 'resource', capability: 'runtime.resource' },
  { method: 'DELETE', template: '/v1/settings/credentials/:id', owner: 'resource', capability: 'runtime.resource' },
  { method: 'PATCH', template: '/v1/settings/credentials/:id', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/settings/credentials/capability', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/settings/hooks', owner: 'resource', capability: 'runtime.resource' },
  { method: 'PUT', template: '/v1/settings/hooks', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/settings/import/apply', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/settings/import/inventory', owner: 'resource', capability: 'runtime.resource' },
  {
    method: 'POST',
    template: '/v1/settings/import/inventory/open-location',
    owner: 'resource',
    capability: 'runtime.resource'
  },
  { method: 'POST', template: '/v1/settings/import/preview', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/settings/locale', owner: 'resource', capability: 'runtime.resource' },
  { method: 'PUT', template: '/v1/settings/locale', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/settings/locales', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/settings/mcp-servers', owner: 'resource', capability: 'runtime.resource' },
  { method: 'DELETE', template: '/v1/settings/mcp-servers/:name', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/settings/mcp-servers/:name', owner: 'resource', capability: 'runtime.resource' },
  { method: 'PUT', template: '/v1/settings/mcp-servers/:name', owner: 'resource', capability: 'runtime.resource' },
  {
    method: 'GET',
    template: '/v1/settings/mcp-servers/:name/tasks/:taskId',
    owner: 'resource',
    capability: 'runtime.resource'
  },
  {
    method: 'POST',
    template: '/v1/settings/mcp-servers/:name/tasks/:taskId/cancel',
    owner: 'resource',
    capability: 'runtime.resource'
  },
  {
    method: 'POST',
    template: '/v1/settings/mcp-servers/:name/authorize',
    owner: 'resource',
    capability: 'runtime.resource'
  },
  {
    method: 'POST',
    template: '/v1/settings/mcp-servers/:name/disable',
    owner: 'resource',
    capability: 'runtime.resource'
  },
  {
    method: 'POST',
    template: '/v1/settings/mcp-servers/:name/enable',
    owner: 'resource',
    capability: 'runtime.resource'
  },
  {
    method: 'POST',
    template: '/v1/settings/mcp-servers/:name/reconnect',
    owner: 'resource',
    capability: 'runtime.resource'
  },
  { method: 'GET', template: '/v1/settings/mcp-servers/catalog', owner: 'resource', capability: 'runtime.resource' },
  {
    method: 'GET',
    template: '/v1/settings/mcp-servers/registry/search',
    owner: 'resource',
    capability: 'runtime.resource'
  },
  { method: 'GET', template: '/v1/settings/mcp-servers/status', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/settings/model/atom-kinds', owner: 'resource', capability: 'runtime.resource' },
  {
    method: 'POST',
    template: '/v1/settings/model/atom-kinds/discover',
    owner: 'resource',
    capability: 'runtime.resource'
  },
  { method: 'GET', template: '/v1/settings/model/default', owner: 'resource', capability: 'runtime.resource' },
  { method: 'PUT', template: '/v1/settings/model/default', owner: 'resource', capability: 'runtime.resource' },
  {
    method: 'POST',
    template: '/v1/settings/model/embeddings/reindex',
    owner: 'resource',
    capability: 'runtime.resource'
  },
  { method: 'GET', template: '/v1/settings/model/profiles', owner: 'resource', capability: 'runtime.resource' },
  {
    method: 'DELETE',
    template: '/v1/settings/model/profiles/:alias',
    owner: 'resource',
    capability: 'runtime.resource'
  },
  { method: 'GET', template: '/v1/settings/model/profiles/:alias', owner: 'resource', capability: 'runtime.resource' },
  { method: 'PUT', template: '/v1/settings/model/profiles/:alias', owner: 'resource', capability: 'runtime.resource' },
  {
    method: 'PATCH',
    template: '/v1/settings/model/profiles/:alias/alias',
    owner: 'resource',
    capability: 'runtime.resource'
  },
  { method: 'GET', template: '/v1/settings/model/providers', owner: 'resource', capability: 'runtime.resource' },
  { method: 'DELETE', template: '/v1/settings/model/providers/:id', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/settings/model/providers/:id', owner: 'resource', capability: 'runtime.resource' },
  { method: 'PATCH', template: '/v1/settings/model/providers/:id', owner: 'resource', capability: 'runtime.resource' },
  { method: 'PUT', template: '/v1/settings/model/providers/:id', owner: 'resource', capability: 'runtime.resource' },
  {
    method: 'GET',
    template: '/v1/settings/model/providers/:id/credentials',
    owner: 'resource',
    capability: 'runtime.resource'
  },
  {
    method: 'POST',
    template: '/v1/settings/model/providers/:id/credentials',
    owner: 'resource',
    capability: 'runtime.resource'
  },
  {
    method: 'DELETE',
    template: '/v1/settings/model/providers/:id/credentials/:credId',
    owner: 'resource',
    capability: 'runtime.resource'
  },
  {
    method: 'POST',
    template: '/v1/settings/model/providers/:id/credentials/:credId/test',
    owner: 'resource',
    capability: 'runtime.resource'
  },
  {
    method: 'POST',
    template: '/v1/settings/model/providers/:id/disable',
    owner: 'resource',
    capability: 'runtime.resource'
  },
  {
    method: 'POST',
    template: '/v1/settings/model/providers/:id/enable',
    owner: 'resource',
    capability: 'runtime.resource'
  },
  {
    method: 'GET',
    template: '/v1/settings/model/providers/:id/models',
    owner: 'resource',
    capability: 'runtime.resource'
  },
  {
    method: 'GET',
    template: '/v1/settings/model/providers/catalog',
    owner: 'resource',
    capability: 'runtime.resource'
  },
  { method: 'GET', template: '/v1/settings/model/roles', owner: 'resource', capability: 'runtime.resource' },
  { method: 'PUT', template: '/v1/settings/model/roles', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/settings/model/test-connection', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/settings/model/transcribe', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/settings/network', owner: 'resource', capability: 'runtime.resource' },
  { method: 'PUT', template: '/v1/settings/network', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/settings/network/probe', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/settings/obscura', owner: 'resource', capability: 'runtime.resource' },
  { method: 'PUT', template: '/v1/settings/obscura', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/settings/openai-compat', owner: 'resource', capability: 'runtime.resource' },
  { method: 'PUT', template: '/v1/settings/openai-compat', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/settings/peers', owner: 'resource', capability: 'runtime.resource' },
  { method: 'PUT', template: '/v1/settings/peers', owner: 'resource', capability: 'runtime.resource' },
  { method: 'DELETE', template: '/v1/settings/peers/:id', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/settings/peers/:id', owner: 'resource', capability: 'runtime.resource' },
  { method: 'PUT', template: '/v1/settings/peers/:id/credential', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/settings/peers/:id/disable', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/settings/peers/:id/enable', owner: 'resource', capability: 'runtime.resource' },
  {
    method: 'POST',
    template: '/v1/settings/peers/:id/test-connection',
    owner: 'resource',
    capability: 'runtime.resource'
  },
  { method: 'GET', template: '/v1/settings/profile', owner: 'resource', capability: 'runtime.resource' },
  { method: 'PUT', template: '/v1/settings/profile', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/settings/sandbox', owner: 'resource', capability: 'runtime.resource' },
  { method: 'PUT', template: '/v1/settings/sandbox', owner: 'resource', capability: 'runtime.resource' },
  { method: 'PUT', template: '/v1/settings/sandbox/activate', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/settings/startup', owner: 'resource', capability: 'runtime.resource' },
  { method: 'PUT', template: '/v1/settings/startup', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/settings/startup/open', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/settings/tool-backends', owner: 'resource', capability: 'runtime.resource' },
  { method: 'PUT', template: '/v1/settings/tool-backends', owner: 'resource', capability: 'runtime.resource' },
  {
    method: 'POST',
    template: '/v1/settings/tool-backends/init-docker',
    owner: 'resource',
    capability: 'runtime.resource'
  },
  { method: 'GET', template: '/v1/skills/:slug', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/skills/browse', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/skills/search', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/stats', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/system/pick-directory', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/system/upgrade', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/system/upgrade', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/usage', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/usage/reset', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/workplace/projects', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/workplace/projects', owner: 'resource', capability: 'runtime.resource' },
  { method: 'DELETE', template: '/v1/workplace/projects/:id', owner: 'resource', capability: 'runtime.resource' },
  { method: 'GET', template: '/v1/workplace/projects/:id', owner: 'resource', capability: 'runtime.resource' },
  { method: 'PATCH', template: '/v1/workplace/projects/:id', owner: 'resource', capability: 'runtime.resource' },
  { method: 'POST', template: '/v1/workplace/projects/reorder', owner: 'resource', capability: 'runtime.resource' }
] as const satisfies readonly RuntimeBindingDef<'resource'>[];

/** All resource/adapter/gateway/development bindings — the non-Method, non-Stream/Presentation catalog. */
export const RESOURCE_OWNER_BINDINGS: readonly RuntimeBindingDef[] = [
  ...PROTOCOL_ADAPTER_ROUTES,
  ...EXTENSION_GATEWAY_ROUTES,
  ...DEVELOPMENT_ROUTES,
  ...RESOURCE_ROUTES
];
