import { z } from 'zod';

import { httpsUrlSchema, httpUrlSchema } from './url.ts';

export const mcpRegistryEntrySchema = z.object({
  id: z.string(),
  registry: z.string(),
  name: z.string(),
  description: z.string(),
  homepage: httpsUrlSchema.optional(),
  transport: z.enum(['stdio', 'http']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: httpUrlSchema.optional(),
  env: z.array(z.string()),
  verified: z.boolean().optional(),
  stats: z.object({ weeklyDownloads: z.number().optional(), stars: z.number().optional() }).optional()
});
export type McpRegistryEntry = z.infer<typeof mcpRegistryEntrySchema>;

export const searchMcpRegistryResponseSchema = z.object({
  entries: z.array(mcpRegistryEntrySchema),
  query: z.string()
});
export type SearchMcpRegistryResponse = z.infer<typeof searchMcpRegistryResponseSchema>;

export const skillSortModeSchema = z.enum(['trending', 'top', 'new']);
export type SkillSortMode = z.infer<typeof skillSortModeSchema>;

export const skillMarketplaceSourceSchema = z.enum([
  'clawhub',
  'skills.sh',
  'mcpservers.org',
  'ClaudeSkills.info',
  'SkillsLLM'
]);
export type SkillMarketplaceSource = z.infer<typeof skillMarketplaceSourceSchema>;
export interface SkillMarketplaceSourceMeta {
  label: string;
  source: SkillMarketplaceSource;
  supportsCuratedSorts: boolean;
  requiresInstallSource: boolean;
  installSourcePrefix?: string;
}
export const DEFAULT_SKILL_MARKETPLACE_SOURCE: SkillMarketplaceSource = 'clawhub';
export const SKILL_MARKETPLACE_SOURCES: SkillMarketplaceSourceMeta[] = [
  {
    source: 'clawhub',
    label: 'ClawHub',
    supportsCuratedSorts: true,
    requiresInstallSource: false,
    installSourcePrefix: 'clawhub:'
  },
  { source: 'skills.sh', label: 'skills.sh', supportsCuratedSorts: false, requiresInstallSource: true },
  { source: 'mcpservers.org', label: 'mcpservers.org', supportsCuratedSorts: false, requiresInstallSource: true },
  { source: 'ClaudeSkills.info', label: 'ClaudeSkills.info', supportsCuratedSorts: false, requiresInstallSource: true },
  { source: 'SkillsLLM', label: 'SkillsLLM', supportsCuratedSorts: false, requiresInstallSource: true }
];

export function skillMarketplaceSourceMeta(source: SkillMarketplaceSource): SkillMarketplaceSourceMeta {
  return (
    SKILL_MARKETPLACE_SOURCES.find((entry) => entry.source === source) ?? {
      source,
      label: source,
      supportsCuratedSorts: false,
      requiresInstallSource: true
    }
  );
}

export const skillSearchResultSchema = z.object({
  id: z.string(),
  source: skillMarketplaceSourceSchema,
  name: z.string(),
  description: z.string(),
  score: z.number().nullish(),
  version: z.string().nullish(),
  downloads: z.number().nullish(),
  homepage: httpsUrlSchema.nullish(),
  installSource: z.string().nullish()
});
export type SkillSearchResult = z.infer<typeof skillSearchResultSchema>;

export const searchSkillsResponseSchema = z.object({
  results: z.array(skillSearchResultSchema),
  query: z.string(),
  sort: skillSortModeSchema.optional(),
  source: skillMarketplaceSourceSchema.optional()
});
export type SearchSkillsResponse = z.infer<typeof searchSkillsResponseSchema>;

export const skillDetailSchema = z.object({
  id: z.string(),
  source: skillMarketplaceSourceSchema,
  name: z.string(),
  summary: z.string().nullish(),
  content: z.string(),
  downloads: z.number().nullish(),
  version: z.string().nullish(),
  homepage: httpsUrlSchema.nullish(),
  installSource: z.string().nullish()
});
export type SkillDetail = z.infer<typeof skillDetailSchema>;
