import type {
  AdapterMigrationSource,
  NativeCliAgentView,
  NativeCliProvider,
  NativeCliSettingsImportCandidate,
  NativeCliSettingsImportItem,
  NativeCliSettingsImportPreview
} from '@monad/protocol';
import type { BinProbes, NativeCliSettingsImport } from '@monad/sdk-atom';

import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { ModelProviderType } from '@monad/protocol';

const MAX_CONFIG_BYTES = 5 * 1024 * 1024;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function publicItemWithoutHash(item: NativeCliSettingsImportItem): Omit<NativeCliSettingsImportItem, 'hash'> {
  const { hash: _hash, ...rest } = item;
  return rest;
}

export function nativeCliSettingsImportItemHash(item: Omit<NativeCliSettingsImportItem, 'hash'>): string {
  return sha256(stableJson(item));
}

function withHash(item: Omit<NativeCliSettingsImportItem, 'hash'>): NativeCliSettingsImportItem {
  return { ...item, hash: nativeCliSettingsImportItemHash(item) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : undefined;
}

function recordAt(value: unknown, path: string[]): Record<string, unknown> | undefined {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return isRecord(current) ? current : undefined;
}

function getPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'imported';
}

async function pathInfo(inputPath: string): Promise<{ root: string; isDir: boolean }> {
  const root = resolve(inputPath.startsWith('~/') ? join(homedir(), inputPath.slice(2)) : inputPath);
  const info = await stat(root);
  return { root, isDir: info.isDirectory() };
}

async function readConfigObject(
  root: string,
  isDir: boolean,
  names: string[]
): Promise<{ path: string; data: unknown } | null> {
  const candidates = isDir ? names.map((name) => join(root, ...name.split(/[\\/]+/).filter(Boolean))) : [root];
  for (const path of candidates) {
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(path);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    if (info.size > MAX_CONFIG_BYTES) {
      throw new Error(`config file "${path}" is too large (${info.size} bytes; max ${MAX_CONFIG_BYTES})`);
    }
    const text = await Bun.file(path).text();
    if (extname(path) === '.toml') return { path, data: Bun.TOML.parse(text) };
    if (extname(path) === '.yaml' || extname(path) === '.yml') return { path, data: Bun.YAML.parse(text) };
    return { path, data: JSON.parse(text) };
  }
  return null;
}

function defaultCandidates(
  provider: NativeCliProvider,
  label: string,
  paths: Array<{ path: string; scope: NativeCliSettingsImportCandidate['scope']; label?: string }>,
  probes: BinProbes | undefined
): NativeCliSettingsImportCandidate[] {
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

function agentItem(
  source: string,
  target: string,
  agent: NativeCliAgentView,
  summary?: string
): NativeCliSettingsImportItem {
  return withHash({
    id: `nativeCliAgents:${target}`,
    category: 'nativeCliAgents',
    source,
    target,
    action: 'add',
    reason: 'provider settings can be represented as a Monad native CLI agent',
    risk: 'low',
    ...(summary ? { summary } : {}),
    agent
  });
}

function previewItem(
  category: NativeCliSettingsImportItem['category'],
  source: string,
  target: string,
  reason: string,
  payload: unknown,
  options: {
    action?: NativeCliSettingsImportItem['action'];
    risk?: NativeCliSettingsImportItem['risk'];
    summary?: string;
  } = {}
): NativeCliSettingsImportItem {
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

function secretEnvRefs(raw: unknown): Record<string, string> | undefined {
  if (!isRecord(raw)) return undefined;
  const entries = Object.keys(raw)
    .filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    .sort()
    .map((key) => [key, `\${env:${key}}`]);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function mcpEntries(value: unknown): Array<[string, unknown]> {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index): Array<[string, unknown]> => {
      if (!isRecord(entry)) return [];
      const name = asString(entry.name) ?? asString(entry.id) ?? `server-${index + 1}`;
      return [[name, entry]];
    });
  }
  return isRecord(value) ? Object.entries(value) : [];
}

function mcpPayload(name: string, raw: unknown): { summary?: string; payload: unknown } | null {
  if (!isRecord(raw)) return null;
  const command = asString(raw.command);
  const url = asString(raw.url) ?? asString(raw.endpoint);
  if (command) {
    const args = asStringArray(raw.args) ?? [];
    const env = secretEnvRefs(raw.env);
    return {
      summary: command,
      payload: {
        kind: 'mcpServer',
        server: {
          name,
          transport: 'stdio',
          command,
          args,
          ...(env ? { env } : {}),
          enabled: true
        }
      }
    };
  }
  if (url) {
    return {
      summary: url,
      payload: {
        kind: 'mcpServer',
        server: {
          name,
          transport: 'http',
          url,
          auth: { mode: 'none' },
          enabled: true
        }
      }
    };
  }
  return null;
}

function addMcpItems(
  items: NativeCliSettingsImportItem[],
  sourcePath: string,
  data: Record<string, unknown>,
  provider: NativeCliProvider
): void {
  const servers =
    recordAt(data, ['mcp_servers']) ?? recordAt(data, ['mcpServers']) ?? recordAt(data, ['mcp', 'servers']) ?? {};
  for (const [name, raw] of mcpEntries(servers)) {
    const mapped = mcpPayload(name, raw);
    items.push(
      previewItem(
        'mcpServers',
        `${sourcePath}:mcp.${name}`,
        name,
        mapped ? `${provider} MCP server maps to monad mcpServers` : `Unsupported ${provider} MCP shape`,
        mapped?.payload ?? { kind: 'manual' },
        {
          action: mapped ? 'add' : 'manual',
          risk: mapped?.summary === 'npx' || mapped?.payload ? 'medium' : 'medium',
          summary: mapped?.summary
        }
      )
    );
  }
}

async function addSkillItems(items: NativeCliSettingsImportItem[], source: string, root: string): Promise<void> {
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

function providerTypeFromName(name: string): ModelProviderType | null {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalized === 'anthropic' || normalized === 'claude') return ModelProviderType.Anthropic;
  if (normalized === 'openai') return ModelProviderType.OpenAI;
  if (normalized === 'openrouter') return ModelProviderType.OpenRouter;
  if (normalized === 'google' || normalized === 'gemini') return ModelProviderType.Google;
  if (normalized === 'ollama') return ModelProviderType.Ollama;
  return null;
}

function addModelItems(
  items: NativeCliSettingsImportItem[],
  sourcePath: string,
  data: Record<string, unknown>,
  provider: NativeCliProvider
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

function addChannelItems(
  items: NativeCliSettingsImportItem[],
  sourcePath: string,
  data: Record<string, unknown>,
  provider: NativeCliProvider
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

function addMonadAgentItem(
  items: NativeCliSettingsImportItem[],
  sourcePath: string,
  data: Record<string, unknown>,
  provider: NativeCliProvider
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

function sourcesForRequest(
  path: string | undefined,
  sources: AdapterMigrationSource[] | undefined
): AdapterMigrationSource[] {
  if (sources?.length) return sources;
  if (path) return [{ path, scope: 'manual' }];
  return [];
}

function targetForScope(provider: NativeCliProvider, scope: AdapterMigrationSource['scope']): string {
  if (scope === 'workspace') return `${provider}-workspace`;
  if (scope === 'profile') return `${provider}-profile`;
  return provider;
}

function mergePreview(
  provider: NativeCliProvider,
  sources: AdapterMigrationSource[],
  items: NativeCliSettingsImportItem[],
  warnings: string[]
): NativeCliSettingsImportPreview {
  return {
    provider,
    path: sources[0]?.path ?? '',
    sources,
    items,
    warnings
  };
}

export function createCodexSettingsImport(): NativeCliSettingsImport {
  return {
    detect(probes) {
      return defaultCandidates('codex', 'Codex', [{ path: join(homedir(), '.codex'), scope: 'global' }], probes);
    },
    async preview({ path, sources }): Promise<NativeCliSettingsImportPreview> {
      const warnings: string[] = [];
      const normalizedSources: AdapterMigrationSource[] = [];
      const items: NativeCliSettingsImportItem[] = [];
      for (const source of sourcesForRequest(path, sources)) {
        const { root, isDir } = await pathInfo(source.path);
        const normalizedSource = { ...source, path: root };
        normalizedSources.push(normalizedSource);
        const cfg = await readConfigObject(root, isDir, ['config.toml', 'browser/config.toml']);
        const data = isRecord(cfg?.data) ? cfg.data : {};
        if (!cfg) warnings.push(`No Codex config.toml found at ${root}.`);
        const model = asString(data.model);
        const target = targetForScope('codex', source.scope);
        const agent: NativeCliAgentView = {
          name: target,
          provider: 'codex',
          productIcon: 'codex',
          command: 'codex',
          args: [],
          ...(model ? { modelOptions: [model] } : {}),
          enabled: true,
          defaultLaunchMode: 'pty',
          allowDangerousMode: false,
          approvalOwnership: 'provider-owned'
        };
        items.push(agentItem(cfg?.path ?? root, target, agent, model ? `model=${model}` : undefined));
        if (cfg) addMcpItems(items, cfg.path, data, 'codex');
        if (isDir) await addSkillItems(items, 'codex:skills', join(root, 'skills'));
      }
      return mergePreview('codex', normalizedSources, items, warnings);
    }
  };
}

export function createClaudeCodeSettingsImport(): NativeCliSettingsImport {
  return {
    detect(probes) {
      return defaultCandidates(
        'claude-code',
        'Claude Code',
        [{ path: join(homedir(), '.claude'), scope: 'global' }],
        probes
      );
    },
    async preview({ path, sources }): Promise<NativeCliSettingsImportPreview> {
      const warnings: string[] = [];
      const normalizedSources: AdapterMigrationSource[] = [];
      const items: NativeCliSettingsImportItem[] = [];
      for (const source of sourcesForRequest(path, sources)) {
        const { root, isDir } = await pathInfo(source.path);
        const normalizedSource = { ...source, path: root };
        normalizedSources.push(normalizedSource);
        const cfg = await readConfigObject(root, isDir, ['settings.json', '.claude/settings.json']);
        const data = isRecord(cfg?.data) ? cfg.data : {};
        if (!cfg) warnings.push(`No Claude Code settings.json found at ${root}.`);
        const env = isRecord(data.env)
          ? Object.fromEntries(
              Object.keys(data.env)
                .filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
                .sort()
                .map((key) => [key, `\${env:${key}}`])
            )
          : undefined;
        const model = asString(data.model) ?? asString(data.defaultModel);
        const modelOptions = asStringArray(data.modelOptions) ?? (model ? [model] : undefined);
        const target = targetForScope('claude-code', source.scope);
        const agent: NativeCliAgentView = {
          name: target,
          provider: 'claude-code',
          productIcon: 'claude-code',
          command: 'claude',
          args: [],
          ...(env && Object.keys(env).length > 0 ? { env } : {}),
          ...(modelOptions ? { modelOptions } : {}),
          enabled: true,
          defaultLaunchMode: 'pty',
          allowDangerousMode: false,
          approvalOwnership: 'provider-owned'
        };
        items.push(
          agentItem(cfg?.path ?? root, target, agent, modelOptions ? `models=${modelOptions.join(',')}` : undefined)
        );
        if (cfg) addMcpItems(items, cfg.path, data, 'claude-code');
        if (isDir) await addSkillItems(items, 'claude-code:skills', join(root, 'skills'));
      }
      return mergePreview('claude-code', normalizedSources, items, warnings);
    }
  };
}

function frameworkConfigNames(provider: 'hermes' | 'openclaw'): string[] {
  return provider === 'hermes'
    ? ['config.yaml', 'config.yml', 'config.json', 'hermes.yaml', 'hermes.json']
    : ['openclaw.json', 'config.json', 'config.yaml', 'config.yml', 'openclaw.yaml', 'openclaw.yml'];
}

export function createFrameworkSettingsImport(provider: 'hermes' | 'openclaw', label: string): NativeCliSettingsImport {
  return {
    detect(probes) {
      return defaultCandidates(provider, label, [{ path: join(homedir(), `.${provider}`), scope: 'global' }], probes);
    },
    async preview({ path, sources }): Promise<NativeCliSettingsImportPreview> {
      const warnings: string[] = [];
      const normalizedSources: AdapterMigrationSource[] = [];
      const items: NativeCliSettingsImportItem[] = [];
      for (const source of sourcesForRequest(path, sources)) {
        const { root, isDir } = await pathInfo(source.path);
        normalizedSources.push({ ...source, path: root });
        const cfg = await readConfigObject(root, isDir, frameworkConfigNames(provider));
        const data = isRecord(cfg?.data) ? cfg.data : {};
        if (!cfg) {
          warnings.push(`No ${provider} config file found at ${root}.`);
        } else {
          addMcpItems(items, cfg.path, data, provider);
          addModelItems(items, cfg.path, data, provider);
          addChannelItems(items, cfg.path, data, provider);
          addMonadAgentItem(items, cfg.path, data, provider);
        }
        const target = targetForScope(provider, source.scope);
        const agent: NativeCliAgentView = {
          name: target,
          provider,
          productIcon: provider,
          command: provider,
          args: [],
          enabled: true,
          defaultLaunchMode: 'pty',
          allowDangerousMode: false,
          approvalOwnership: 'provider-owned'
        };
        items.push(agentItem(cfg?.path ?? root, target, agent));
        if (isDir) await addSkillItems(items, `${provider}:skills`, join(root, 'skills'));
      }
      return mergePreview(provider, normalizedSources, items, warnings);
    }
  };
}

export function createBasicSettingsImport(
  provider: NativeCliProvider,
  label: string,
  command: string,
  homeConfigDir: string,
  configNames = ['settings.json', 'config.json', 'config.yaml', 'config.yml']
): NativeCliSettingsImport {
  return {
    detect(probes) {
      return defaultCandidates(provider, label, [{ path: join(homedir(), homeConfigDir), scope: 'global' }], probes);
    },
    async preview({ path, sources }): Promise<NativeCliSettingsImportPreview> {
      const warnings: string[] = [];
      const normalizedSources: AdapterMigrationSource[] = [];
      const items: NativeCliSettingsImportItem[] = [];
      for (const source of sourcesForRequest(path, sources)) {
        const { root, isDir } = await pathInfo(source.path);
        normalizedSources.push({ ...source, path: root });
        const cfg = await readConfigObject(root, isDir, configNames);
        const data = isRecord(cfg?.data) ? cfg.data : {};
        if (!cfg) warnings.push(`No ${label} settings/config file found at ${root}.`);
        else addMcpItems(items, cfg.path, data, provider);
        const target = targetForScope(provider, source.scope);
        const agent: NativeCliAgentView = {
          name: target,
          provider,
          productIcon: provider,
          command,
          args: [],
          enabled: true,
          defaultLaunchMode: 'pty',
          allowDangerousMode: false,
          approvalOwnership: 'provider-owned'
        };
        items.push(agentItem(cfg?.path ?? root, target, agent));
        if (isDir) await addSkillItems(items, `${provider}:skills`, join(root, 'skills'));
      }
      return mergePreview(provider, normalizedSources, items, warnings);
    }
  };
}

export function nativeCliSettingsImportPreviewItemChanged(
  item: NativeCliSettingsImportItem,
  expectedHash: string | undefined
): boolean {
  return !expectedHash || nativeCliSettingsImportItemHash(publicItemWithoutHash(item)) !== expectedHash;
}
