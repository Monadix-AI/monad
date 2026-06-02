import { z } from 'zod';

import { projectIdSchema, projectMemberIdSchema, sessionIdSchema } from '../ids.ts';
import { meshAgentNameSchema, meshAgentProviderSchema } from './mesh-agent-config.ts';

export const nativeAgentWorkspaceScopesSchema = z.object({
  project: z.string().min(1),
  shared: z.string().min(1),
  agent: z.string().min(1),
  session: z.string().min(1),
  runtime: z.string().min(1)
});
export type NativeAgentWorkspaceScopes = z.infer<typeof nativeAgentWorkspaceScopesSchema>;

export const nativeAgentRuntimePromptInputSchema = z.object({
  agentName: meshAgentNameSchema,
  agentId: projectMemberIdSchema,
  displayName: meshAgentNameSchema.optional(),
  projectId: projectIdSchema,
  sessionId: sessionIdSchema,
  provider: meshAgentProviderSchema,
  workspace: z.string().min(1),
  workspaces: nativeAgentWorkspaceScopesSchema,
  modelName: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  reasoningEffort: z.string().min(1).optional(),
  speed: z.enum(['standard', 'fast']).optional(),
  customPrompt: z.string().optional()
});
export type NativeAgentRuntimePromptInput = z.infer<typeof nativeAgentRuntimePromptInputSchema>;

export const managedProjectRuntimePromptInputSchema = nativeAgentRuntimePromptInputSchema;
export type ManagedProjectRuntimePromptInput = NativeAgentRuntimePromptInput;

export const nativeAgentMonadCliEntrySchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string())
});
export type NativeAgentMonadCliEntry = z.infer<typeof nativeAgentMonadCliEntrySchema>;

export const nativeAgentManagedMcpServerSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string())
});
export type NativeAgentManagedMcpServer = z.infer<typeof nativeAgentManagedMcpServerSchema>;

export const nativeAgentRuntimeSpecSchema = z.object({
  workspace: z.string(),
  workspaces: nativeAgentWorkspaceScopesSchema,
  promptFile: z.string(),
  tokenFile: z.string(),
  tokenHash: z.string(),
  monadCliEntry: nativeAgentMonadCliEntrySchema,
  mcpServer: nativeAgentManagedMcpServerSchema,
  mcpConfigArgs: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()),
  prompt: z.string()
});
export type NativeAgentRuntimeSpec = z.infer<typeof nativeAgentRuntimeSpecSchema>;

export const managedProjectRuntimeSpecSchema = nativeAgentRuntimeSpecSchema;
export type ManagedProjectRuntimeSpec = NativeAgentRuntimeSpec;
