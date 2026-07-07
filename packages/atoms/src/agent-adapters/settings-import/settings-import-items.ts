import type {
  AdapterMigrationSource,
  ExternalAgentProvider,
  ExternalAgentSettingsImportCandidate,
  ExternalAgentSettingsImportItem,
  ExternalAgentSettingsImportPreview,
  ExternalAgentView
} from '@monad/protocol';
import type { BinProbes } from '@monad/sdk-atom';

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ModelProviderType } from '@monad/protocol';

import { withHash } from './settings-import-hash.ts';
import { asString, getPath, isRecord, recordAt, sanitizeId } from './settings-import-parse.ts';

export function defaultCandidates(
  provider: ExternalAgentProvider,
  label: string,
  paths: Array<{ path: string; scope: ExternalAgentSettingsImportCandidate['scope']; label?: string }>,
  probes: BinProbes | undefined
): ExternalAgentSettingsImportCandidate[] {
  return paths
    .filter(({ path }) => probes?.exists(path) ?? false)
    .map(({ path, scope, label: candidateLabel }) => ({
      provider,
      label: candidateLabel ?? label,
      path,
      source: 'default',
      scope
    }));
}

export function agentItem(
  source: string,
  target: string,
  agent: ExternalAgentView,
  summary?: string
): ExternalAgentSettingsImportItem {
  return withHash({
    id: `externalAgents:${target}`,
    category: 'externalAgents',
    source,
    target,
    action: 'add',
    reason: 'provider settings can be represented as a Monad external agent',
    risk: 'low',
    ...(summary ? { summary } : {}),
    agent
  });
}

export function previewItem(
  category: ExternalAgentSettingsImportItem['category'],
  source: string,
  target: string,
  reason: string,
  payload: unknown,
  options: {
    action?: ExternalAgentSettingsImportItem['action'];
    risk?: ExternalAgentSettingsImportItem['risk'];
    summary?: string;
  } = {}
): ExternalAgentSettingsImportItem {
  return withHash({
    id: `${category}:${target}`,
    category,
    source,
    target,
    action: options.action ?? 'add',
    reason,
    risk: options.risk ?? 'low',
    ...(options.summary ? { summary: options.summary } : {}),
    payload
  });
}

export async function addSkillItems(
  items: ExternalAgentSettingsImportItem[],
  source: string,
  root: string
): Promise<void> {
  try {
    const entries = await readdir(root, { withFileTypes: true, encoding: 'utf8' });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = join(root, entry.name);
      try {
        const info = await stat(join(skillDir, 'SKILL.md'));
        if (!info.isFile()) continue;
      } catch {
        continue;
      }
      items.push(
        previewItem(
          'skills',
          join(source, entry.name),
          entry.name,
          'provider skill directory can be imported as a Monad skill',
          {
            kind: 'skill',
            dir: skillDir,
            name: entry.name
          }
        )
      );
    }
  } catch {
    return;
  }
}

export function providerTypeFromName(name: string): ModelProviderType | null {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalized === 'anthropic' || normalized === 'claude') return ModelProviderType.Anthropic;
  if (normalized === 'openai') return ModelProviderType.OpenAI;
  if (normalized === 'openrouter') return ModelProviderType.OpenRouter;
  if (normalized === 'google' || normalized === 'gemini') return ModelProviderType.Google;
  if (normalized === 'ollama') return ModelProviderType.Ollama;
  return null;
}

export function addModelItems(
  items: ExternalAgentSettingsImportItem[],
  sourcePath: string,
  data: Record<string, unknown>,
  provider: ExternalAgentProvider
): void {
  const model = asString(getPath(data, ['model', 'default'])) ?? asString(data.default_model) ?? asString(data.model);
  const providerId =
    asString(getPath(data, ['model', 'provider'])) ?? (model?.includes('/') ? model.split('/')[0] : undefined);
  if (!model || !providerId) return;
  const providerType = providerTypeFromName(providerId);
  if (!providerType) {
    items.push(
      previewItem(
        'modelProviders',
        `${sourcePath}:model.provider`,
        providerId,
        `${provider} model provider must be reviewed manually`,
        { kind: 'manual' },
        { action: 'manual', risk: 'medium', summary: `model=${model}` }
      )
    );
    return;
  }
  const modelId = model.includes('/') ? (model.split('/').pop() ?? model) : model;
  items.push(
    previewItem(
      'modelProviders',
      `${sourcePath}:model.provider`,
      providerId,
      `${provider} provider maps to monad model provider`,
      {
        kind: 'modelProvider',
        provider: { id: providerId, label: providerId, type: providerType }
      }
    )
  );
  items.push(
    previewItem(
      'modelProfiles',
      `${sourcePath}:model.default`,
      `${provider}-${sanitizeId(modelId)}`,
      `${provider} default model maps to a monad model profile`,
      {
        kind: 'modelProfile',
        profile: {
          alias: `${provider}-${sanitizeId(modelId)}`,
          routes: { chat: { provider: providerId, modelId } },
          params: {},
          fallbacks: []
        }
      },
      { summary: `${providerId}/${modelId}` }
    )
  );
}

export function addChannelItems(
  items: ExternalAgentSettingsImportItem[],
  sourcePath: string,
  data: Record<string, unknown>,
  provider: ExternalAgentProvider
): void {
  const channels = recordAt(data, ['channels']) ?? {};
  for (const [name, raw] of Object.entries(channels)) {
    if (!isRecord(raw)) continue;
    const tokenEnv = asString(raw.token_env) ?? asString(raw.tokenEnv);
    const id = `chn_${sanitizeId(`${provider}-${name}`).replace(/-/g, '_')}`;
    items.push(
      previewItem('channels', `${sourcePath}:channels.${name}`, id, `${provider} channel maps to a monad channel`, {
        kind: 'channel',
        channel: {
          id,
          type: name,
          label: `${provider} ${name}`,
          enabled: true,
          options: {},
          tokenRef: tokenEnv ? `\${env:${tokenEnv}}` : `\${secret:channel/${id}/token}`
        }
      })
    );
  }
}

export function addMonadAgentItem(
  items: ExternalAgentSettingsImportItem[],
  sourcePath: string,
  data: Record<string, unknown>,
  provider: ExternalAgentProvider
): void {
  const agent = recordAt(data, ['agent']);
  if (!agent) return;
  const name = asString(agent.name) ?? `${provider}-agent`;
  const prompt = asString(agent.prompt) ?? asString(agent.system_prompt) ?? `Use ${provider} imported behavior.`;
  items.push(
    previewItem('agents', `${sourcePath}:agent`, name, `${provider} agent persona maps to a monad agent`, {
      kind: 'agent',
      name,
      prompt,
      framework: provider
    })
  );
}

export function sourcesForRequest(
  path: string | undefined,
  sources: AdapterMigrationSource[] | undefined
): AdapterMigrationSource[] {
  if (sources?.length) return sources;
  if (path) return [{ path, scope: 'manual' }];
  return [];
}

export function targetForScope(provider: ExternalAgentProvider, scope: AdapterMigrationSource['scope']): string {
  if (scope === 'workspace') return `${provider}-workspace`;
  if (scope === 'profile') return `${provider}-profile`;
  return provider;
}

export function mergePreview(
  provider: ExternalAgentProvider,
  sources: AdapterMigrationSource[],
  items: ExternalAgentSettingsImportItem[],
  warnings: string[]
): ExternalAgentSettingsImportPreview {
  return {
    provider,
    path: sources[0]?.path ?? '',
    sources,
    items,
    warnings
  };
}
