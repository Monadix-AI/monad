import { z } from 'zod';

import { nativeCliProductIconSchema } from './native-cli-agent.ts';

// Settings-UI view of a configured external ACP agent (the registry monad delegates subtasks to via
// the `agent_acp_delegate` tool). Mirrors @monad/home's acpAgentSchema field-for-field; no secret
// stripping is needed because `env` values are `${env:NAME}` refs, not stored secrets. acpAgents are
// SYSTEM config (config.json); edits re-apply the agent_acp_delegate tool live (no restart).
export const acpAgentViewSchema = z.object({
  name: z.string().min(1),
  productIcon: nativeCliProductIconSchema.optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  enabled: z.boolean(),
  // Opt-in OS-level double-sandbox for the adapter process (default off). See acpAgentSchema.osSandbox.
  osSandbox: z.boolean().optional(),
  // Opt-in: forward monad's configured MCP servers to this agent's delegated session (default off).
  forwardMcp: z.boolean().optional()
});
export type AcpAgentView = z.infer<typeof acpAgentViewSchema>;

export const listAcpAgentsResponseSchema = z.object({ agents: z.array(acpAgentViewSchema) });
export type ListAcpAgentsResponse = z.infer<typeof listAcpAgentsResponseSchema>;

export const upsertAcpAgentRequestSchema = z.object({ agent: acpAgentViewSchema });
export type UpsertAcpAgentRequest = z.infer<typeof upsertAcpAgentRequestSchema>;

export const setAcpAgentEnabledRequestSchema = z.object({ enabled: z.boolean() });
export type SetAcpAgentEnabledRequest = z.infer<typeof setAcpAgentEnabledRequestSchema>;

// A turnkey "invite" preset for a same-machine third-party agent (Codex / Claude Code). `command`,
// `args`, `env` are a ready-made acpAgents entry the UI prefills on invite; `installed` is the result
// of probing the local machine for the underlying tool, so the UI can badge it and surface installHint.
export const acpAgentPresetSchema = z.object({
  id: z.string(),
  label: z.string(),
  productIcon: nativeCliProductIconSchema,
  command: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()).optional(),
  installHint: z.string(),
  installed: z.boolean(),
  resolvedBinPath: z.string().optional()
});
export type AcpAgentPresetView = z.infer<typeof acpAgentPresetSchema>;

export const listAcpAgentPresetsResponseSchema = z.object({ presets: z.array(acpAgentPresetSchema) });
export type ListAcpAgentPresetsResponse = z.infer<typeof listAcpAgentPresetsResponseSchema>;
