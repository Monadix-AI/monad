import { z } from 'zod';

import { projectIdSchema } from '../ids.ts';
import { meshAgentNameSchema, meshAgentProviderSchema } from './mesh-agent-config.ts';

export const nativeAgentRuntimePromptInputSchema = z.object({
  agentName: meshAgentNameSchema,
  displayName: meshAgentNameSchema.optional(),
  projectId: projectIdSchema,
  provider: meshAgentProviderSchema,
  workspace: z.string().min(1),
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

export const nativeAgentRuntimeSpecSchema = z.object({
  workspace: z.string(),
  promptFile: z.string(),
  tokenFile: z.string(),
  tokenHash: z.string(),
  monadCliEntry: nativeAgentMonadCliEntrySchema,
  mcpConfigArgs: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()),
  prompt: z.string()
});
export type NativeAgentRuntimeSpec = z.infer<typeof nativeAgentRuntimeSpecSchema>;

export const managedProjectRuntimeSpecSchema = nativeAgentRuntimeSpecSchema;
export type ManagedProjectRuntimeSpec = NativeAgentRuntimeSpec;
