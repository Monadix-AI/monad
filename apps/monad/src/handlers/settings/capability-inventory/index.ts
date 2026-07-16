import type { Dirent } from 'node:fs';
import type { MonadPaths } from '@monad/environment';
import type {
  CapabilityInventoryItem,
  CapabilityInventoryOpenLocationRequest,
  CapabilityInventoryResponse,
  CapabilityInventoryRoot,
  CapabilityInventoryScope,
  CapabilityInventorySource,
  ExternalAgentProvider
} from '@monad/protocol';

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { openNativePath } from '@monad/environment';

import { defaultBinProbes } from '#/infra/resolve-binary.ts';
import { listExternalAgentProviderAdapters } from '#/services/external-agent/index.ts';

const MAX_CONFIG_BYTES = 5 * 1024 * 1024;
const MAX_SKILL_MD_BYTES = 1024 * 1024;

interface RootSpec {
  source: CapabilityInventorySource;
  sourceLabel: string;
  scope: CapabilityInventoryScope;
  kind: CapabilityInventoryRoot['kind'];
  path: string;
  shared?: boolean;
  provider?: ExternalAgentProvider;
}

interface MappedMcpServer {
  transport: 'stdio' | 'http' | 'unknown';
  command?: string;
  url?: string;
}

interface MappedModelProvider {
  name: string;
  providerType?: string;
  model?: string;
  raw: unknown;
}

interface SkillRootTarget {
  source: CapabilityInventorySource;
  sourceLabel: string;
  path: string;
  shared?: boolean;
}

function uniqueSpecs(specs: RootSpec[]): RootSpec[] {
  const seen = new Set<string>();
  return specs.filter((spec) => {
    const key = `${spec.kind}:${resolve(spec.path)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9:_./-]+/g, '-');
}

async function rootStatus(spec: RootSpec): Promise<CapabilityInventoryRoot> {
  try {
    const info = await stat(detectPathForRoot(spec));
    return {
      ...spec,
      exists: info.isDirectory(),
      shared: spec.shared ?? false
    };
  } catch {
    return { ...spec, exists: false, shared: spec.shared ?? false };
  }
}

function detectPathForRoot(spec: RootSpec): string {
  if (spec.kind === 'skills' && basename(spec.path) === 'skills') return dirname(spec.path);
  if (spec.kind === 'mcpServers' && isConfigFileName(basename(spec.path))) return dirname(spec.path);
  if (spec.kind === 'mcpServers' && basename(spec.path) === 'mcp') return dirname(spec.path);
  return spec.path;
}

function isConfigFileName(name: string): boolean {
  return /^(settings|config|mcp|claude_desktop_config)\.(json|toml|ya?ml)$/i.test(name);
}

function rootMatchesRequest(spec: RootSpec, req: CapabilityInventoryOpenLocationRequest): boolean {
  return (
    spec.source === req.source &&
    spec.sourceLabel === req.sourceLabel &&
    spec.scope === req.scope &&
    spec.kind === req.kind &&
    resolve(spec.path) === resolve(req.path)
  );
}

function frontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*["']?([^"'\\n]+)["']?\\s*$`, 'm'));
  return match?.[1]?.trim();
}

function parseSkillMetadata(text: string): { name?: string; description?: string } {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return {};
  const frontmatter = match[1] ?? '';
  return {
    name: frontmatterValue(frontmatter, 'name'),
    description: frontmatterValue(frontmatter, 'description')
  };
}

async function scanSkillRoot(spec: RootSpec): Promise<CapabilityInventoryItem[]> {
  const out: CapabilityInventoryItem[] = [];
  let entries: Dirent<string>[];
  try {
    entries = await readdir(spec.path, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = join(spec.path, entry.name);
    const skillMd = join(skillDir, 'SKILL.md');
    try {
      const info = await stat(skillMd);
      if (!info.isFile()) continue;
      const warnings: string[] = [];
      if (info.size > MAX_SKILL_MD_BYTES) {
        warnings.push(`SKILL.md is too large to inspect (${info.size} bytes)`);
        out.push({
          id: sanitizeId(`skill:${spec.source}:${spec.sourceLabel}:${spec.scope}:${skillDir}`),
          kind: 'skill',
          name: entry.name,
          source: spec.source,
          sourceLabel: spec.sourceLabel,
          scope: spec.scope,
          path: skillDir,
          shared: spec.shared ?? false,
          warnings
        });
        continue;
      }
      const text = await Bun.file(skillMd).text();
      const meta = parseSkillMetadata(text);
      out.push({
        id: sanitizeId(`skill:${spec.source}:${spec.sourceLabel}:${spec.scope}:${skillDir}`),
        kind: 'skill',
        name: meta.name ?? entry.name,
        ...(meta.description ? { description: meta.description } : {}),
        source: spec.source,
        sourceLabel: spec.sourceLabel,
        scope: spec.scope,
        path: skillDir,
        shared: spec.shared ?? false,
        hash: `sha256-${sha256(text)}`,
        warnings: meta.name && meta.name !== entry.name ? [`frontmatter name differs from directory: ${meta.name}`] : []
      });
    } catch {}
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function recordAt(value: unknown, path: string[]): Record<string, unknown> | undefined {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return isRecord(current) ? current : undefined;
}

function valueAt(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
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

function agentEntries(value: unknown): Array<[string, unknown]> {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index): Array<[string, unknown]> => {
      if (!isRecord(entry)) return [];
      const name = asString(entry.name) ?? asString(entry.id) ?? asString(entry.label) ?? `agent-${index + 1}`;
      return [[name, entry]];
    });
  }
  return isRecord(value) ? Object.entries(value) : [];
}

function singleAgentEntry(value: unknown): Array<[string, unknown]> {
  if (!isRecord(value)) return [];
  const name = asString(value.name) ?? asString(value.id) ?? asString(value.label);
  const hasAgentShape =
    Boolean(name) ||
    asString(value.prompt) != null ||
    asString(value.system_prompt) != null ||
    asString(value.description) != null;
  return hasAgentShape ? [[name ?? 'agent', value]] : [];
}

async function readConfig(path: string): Promise<unknown | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) return null;
    const text = await Bun.file(path).text();
    const ext = extname(path);
    if (ext === '.toml') return Bun.TOML.parse(text);
    if (ext === '.yaml' || ext === '.yml') return Bun.YAML.parse(text);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function configuredAgentEntries(data: unknown): Array<[string, unknown]> {
  const agentList = valueAt(data, ['agents', 'list']);
  return [
    agentList,
    agentList == null ? valueAt(data, ['agents']) : undefined,
    valueAt(data, ['agent', 'agents']),
    valueAt(data, ['subagents']),
    valueAt(data, ['sub_agents'])
  ]
    .flatMap(agentEntries)
    .concat(singleAgentEntry(valueAt(data, ['agent'])));
}

function agentDescription(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined;
  return asString(raw.description) ?? asString(raw.summary);
}

function modelProviderFromRaw(name: string, raw: unknown, model?: string): MappedModelProvider {
  if (!isRecord(raw)) return { name, model, raw };
  return {
    name: asString(raw.name) ?? asString(raw.id) ?? asString(raw.provider) ?? name,
    providerType: asString(raw.type) ?? asString(raw.providerType) ?? asString(raw.provider),
    model: asString(raw.model) ?? asString(raw.default_model) ?? asString(raw.defaultModel) ?? model,
    raw
  };
}

function modelProviderEntries(data: unknown): MappedModelProvider[] {
  const out: MappedModelProvider[] = [];
  const model =
    asString(valueAt(data, ['model', 'default'])) ??
    asString(valueAt(data, ['model', 'model'])) ??
    asString(valueAt(data, ['default_model'])) ??
    asString(valueAt(data, ['defaultModel'])) ??
    asString(valueAt(data, ['model']));
  const explicitProvider =
    asString(valueAt(data, ['model', 'provider'])) ??
    asString(valueAt(data, ['provider'])) ??
    (model?.includes('/') ? model.split('/')[0] : undefined);

  if (explicitProvider) {
    out.push({
      name: explicitProvider,
      providerType: explicitProvider,
      model,
      raw: { provider: explicitProvider, model }
    });
  }

  for (const [name, raw] of Object.entries(recordAt(data, ['providers']) ?? {})) {
    out.push(modelProviderFromRaw(name, raw));
  }

  for (const [name, raw] of Object.entries(recordAt(data, ['model', 'providers']) ?? {})) {
    out.push(modelProviderFromRaw(name, raw));
  }

  for (const [name, raw] of Object.entries(recordAt(data, ['auth', 'profiles']) ?? {})) {
    if (!isRecord(raw)) continue;
    const provider = asString(raw.provider) ?? (name.includes(':') ? (name.split(':')[0] ?? name) : name);
    out.push(modelProviderFromRaw(provider, raw));
  }

  const seen = new Set<string>();
  return out.filter((provider) => {
    const key = provider.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function scanModelProviderConfigFile(spec: RootSpec, path: string): Promise<CapabilityInventoryItem[]> {
  const data = await readConfig(path);
  return modelProviderEntries(data).map((provider) => ({
    id: sanitizeId(`modelProvider:${spec.source}:${spec.sourceLabel}:${spec.scope}:${path}:${provider.name}`),
    kind: 'modelProvider' as const,
    name: provider.name,
    ...(provider.providerType ? { providerType: provider.providerType } : {}),
    ...(provider.model ? { model: provider.model } : {}),
    source: spec.source,
    sourceLabel: spec.sourceLabel,
    scope: spec.scope,
    path,
    shared: spec.shared ?? false,
    hash: `sha256-${sha256(JSON.stringify(provider.raw))}`,
    warnings: []
  }));
}

async function scanAgentConfigFile(spec: RootSpec, path: string): Promise<CapabilityInventoryItem[]> {
  const data = await readConfig(path);
  const out: CapabilityInventoryItem[] = [];
  for (const [name, raw] of configuredAgentEntries(data)) {
    const displayName = isRecord(raw) ? (asString(raw.name) ?? asString(raw.id) ?? asString(raw.label) ?? name) : name;
    out.push({
      id: sanitizeId(`agent:${spec.source}:${spec.sourceLabel}:${spec.scope}:${path}:${displayName}`),
      kind: 'agent',
      name: displayName,
      ...(agentDescription(raw) ? { description: agentDescription(raw) } : {}),
      provider: spec.provider ?? spec.sourceLabel,
      source: spec.source,
      sourceLabel: spec.sourceLabel,
      scope: spec.scope,
      path,
      shared: spec.shared ?? false,
      hash: `sha256-${sha256(JSON.stringify(raw))}`,
      warnings: []
    });
  }
  return out;
}

async function scanAgentMarkdownDirectory(spec: RootSpec, path: string): Promise<CapabilityInventoryItem[]> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(path, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return [];
  }

  const out: CapabilityInventoryItem[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.md') continue;
    const filePath = join(path, entry.name);
    try {
      const info = await stat(filePath);
      if (!info.isFile() || info.size > MAX_SKILL_MD_BYTES) continue;
      const text = await Bun.file(filePath).text();
      const meta = parseSkillMetadata(text);
      out.push({
        id: sanitizeId(`agent:${spec.source}:${spec.sourceLabel}:${spec.scope}:${filePath}`),
        kind: 'agent',
        name: meta.name ?? basename(entry.name, '.md'),
        ...(meta.description ? { description: meta.description } : {}),
        provider: spec.provider ?? spec.sourceLabel,
        source: spec.source,
        sourceLabel: spec.sourceLabel,
        scope: spec.scope,
        path: filePath,
        shared: spec.shared ?? false,
        hash: `sha256-${sha256(text)}`,
        warnings: []
      });
    } catch {}
  }
  return out;
}

async function agentDirectoryItem(
  spec: RootSpec,
  dirPath: string,
  name: string,
  metadataFile?: string
): Promise<CapabilityInventoryItem> {
  let description: string | undefined;
  let hashSource = dirPath;
  if (metadataFile) {
    try {
      const info = await stat(metadataFile);
      if (info.isFile() && info.size <= MAX_SKILL_MD_BYTES) {
        const text = await Bun.file(metadataFile).text();
        const meta = parseSkillMetadata(text);
        description = meta.description;
        hashSource = text;
      }
    } catch {}
  }
  return {
    id: sanitizeId(`agent:${spec.source}:${spec.sourceLabel}:${spec.scope}:${dirPath}`),
    kind: 'agent',
    name,
    ...(description ? { description } : {}),
    provider: spec.provider ?? spec.sourceLabel,
    source: spec.source,
    sourceLabel: spec.sourceLabel,
    scope: spec.scope,
    path: dirPath,
    shared: spec.shared ?? false,
    hash: `sha256-${sha256(hashSource)}`,
    warnings: []
  };
}

async function scanAgentDirectories(
  spec: RootSpec,
  path: string,
  metadataFileName?: string
): Promise<CapabilityInventoryItem[]> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(path, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return [];
  }

  const out: CapabilityInventoryItem[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dirPath = join(path, entry.name);
    out.push(
      await agentDirectoryItem(
        spec,
        dirPath,
        entry.name,
        metadataFileName ? join(dirPath, metadataFileName) : undefined
      )
    );
  }
  return out;
}

function isAgentConfigFileName(name: string): boolean {
  return /^(settings|config|agents|subagents|openclaw|hermes)\.(json|toml|ya?ml)$/i.test(name);
}

function isModelProviderConfigFileName(name: string): boolean {
  return /^(settings|config|model|models|providers|openclaw|hermes)\.(json|toml|ya?ml)$/i.test(name);
}

function mcpServerFromRaw(_name: string, raw: unknown): MappedMcpServer {
  if (!isRecord(raw)) return { transport: 'unknown' };
  const command = asString(raw.command);
  const url = asString(raw.url) ?? asString(raw.endpoint);
  if (command) return { transport: 'stdio', command };
  if (url) return { transport: 'http', url };
  return { transport: 'unknown' };
}

async function scanMcpConfigFile(spec: RootSpec, path: string): Promise<CapabilityInventoryItem[]> {
  const data = await readConfig(path);
  const servers =
    recordAt(data, ['mcpServers']) ?? recordAt(data, ['mcp_servers']) ?? recordAt(data, ['mcp', 'servers']) ?? data;
  const out: CapabilityInventoryItem[] = [];
  for (const [name, raw] of mcpEntries(servers)) {
    const mapped = mcpServerFromRaw(name, raw);
    out.push({
      id: sanitizeId(`mcpServer:${spec.source}:${spec.scope}:${path}:${name}`),
      kind: 'mcpServer',
      name,
      source: spec.source,
      sourceLabel: spec.sourceLabel,
      scope: spec.scope,
      path,
      shared: spec.shared ?? false,
      hash: `sha256-${sha256(JSON.stringify(raw))}`,
      warnings: mapped.transport === 'unknown' ? ['unsupported MCP server shape'] : [],
      ...mapped
    });
  }
  return out;
}

async function scanMcpRoot(spec: RootSpec): Promise<CapabilityInventoryItem[]> {
  try {
    const info = await stat(spec.path);
    if (info.isFile()) return scanMcpConfigFile(spec, spec.path);
    if (!info.isDirectory()) return [];
    const entries = await readdir(spec.path, { withFileTypes: true, encoding: 'utf8' });
    const out: CapabilityInventoryItem[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(json|toml|ya?ml)$/i.test(entry.name)) continue;
      out.push(...(await scanMcpConfigFile(spec, join(spec.path, entry.name))));
    }
    return out;
  } catch {
    return [];
  }
}

async function scanAgentRoot(spec: RootSpec): Promise<CapabilityInventoryItem[]> {
  if (!spec.provider) return [];
  try {
    const info = await stat(detectPathForRoot(spec));
    if (!info.isDirectory() && !info.isFile()) return [];
    const out: CapabilityInventoryItem[] = [];
    if (info.isFile() && /\.(json|toml|ya?ml)$/i.test(spec.path))
      out.push(...(await scanAgentConfigFile(spec, spec.path)));
    if (info.isDirectory()) {
      out.push(...(await scanAgentMarkdownDirectory(spec, join(spec.path, 'agents'))));
      out.push(...(await scanAgentMarkdownDirectory(spec, join(spec.path, 'subagents'))));
      out.push(...(await scanAgentDirectories(spec, join(spec.path, 'agents'))));
      out.push(...(await scanAgentDirectories(spec, join(spec.path, 'subagents'))));
      if (spec.provider === 'hermes')
        out.push(...(await scanAgentDirectories(spec, join(spec.path, 'profiles'), 'SOUL.md')));
      const entries = await readdir(spec.path, { withFileTypes: true, encoding: 'utf8' });
      for (const entry of entries) {
        if (!entry.isFile() || !isAgentConfigFileName(entry.name)) continue;
        out.push(...(await scanAgentConfigFile(spec, join(spec.path, entry.name))));
      }
    }
    const seen = new Set<string>();
    return out.filter((item) => {
      const key = `${item.kind}:${item.source}:${item.sourceLabel}:${item.scope}:${item.name.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } catch {
    return [];
  }
}

async function scanModelProviderRoot(spec: RootSpec): Promise<CapabilityInventoryItem[]> {
  if (!spec.provider) return [];
  try {
    const info = await stat(detectPathForRoot(spec));
    if (!info.isDirectory() && !info.isFile()) return [];
    const out: CapabilityInventoryItem[] = [];
    if (info.isFile() && /\.(json|toml|ya?ml)$/i.test(spec.path))
      out.push(...(await scanModelProviderConfigFile(spec, spec.path)));
    if (info.isDirectory()) {
      const entries = await readdir(spec.path, { withFileTypes: true, encoding: 'utf8' });
      for (const entry of entries) {
        if (!entry.isFile() || !isModelProviderConfigFileName(entry.name)) continue;
        out.push(...(await scanModelProviderConfigFile(spec, join(spec.path, entry.name))));
      }
      out.push(...(await scanModelProviderConfigFile(spec, join(spec.path, 'browser', 'config.toml'))));
    }
    const seen = new Set<string>();
    return out.filter((item) => {
      const key = `${item.kind}:${item.source}:${item.sourceLabel}:${item.scope}:${item.name.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } catch {
    return [];
  }
}

function envDir(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

function xdgConfigHome(home: string): string {
  return envDir('XDG_CONFIG_HOME', join(home, '.config'));
}

function firstExistingPath(paths: string[]): string {
  return paths.find((path) => existsSync(path)) ?? paths[0] ?? '';
}

function skillRoots(paths: MonadPaths, home: string): RootSpec[] {
  const configHome = xdgConfigHome(home);
  const codexHome = envDir('CODEX_HOME', join(home, '.codex'));
  const claudeHome = envDir('CLAUDE_CONFIG_DIR', join(home, '.claude'));
  const autohandHome = envDir('AUTOHAND_HOME', join(home, '.autohand'));
  const hermesHome = envDir('HERMES_HOME', join(home, '.hermes'));
  const vibeHome = envDir('VIBE_HOME', join(home, '.vibe'));

  // Mirrors the global skill targets exposed by `npx skills` / vercel-labs/skills.
  const targets: SkillRootTarget[] = [
    { source: 'shared', sourceLabel: 'Universal agents', path: join(home, '.agents', 'skills'), shared: true },
    { source: 'monad', sourceLabel: 'Monad', path: paths.skills },
    { source: 'custom', sourceLabel: 'AiderDesk', path: join(home, '.aider-desk', 'skills') },
    { source: 'custom', sourceLabel: 'Amp', path: join(configHome, 'agents', 'skills') },
    { source: 'custom', sourceLabel: 'Antigravity', path: join(home, '.gemini', 'antigravity', 'skills') },
    { source: 'custom', sourceLabel: 'Antigravity CLI', path: join(home, '.gemini', 'antigravity-cli', 'skills') },
    { source: 'custom', sourceLabel: 'AstrBot', path: join(home, '.astrbot', 'data', 'skills') },
    { source: 'custom', sourceLabel: 'Autohand Code CLI', path: join(autohandHome, 'skills') },
    { source: 'custom', sourceLabel: 'Augment', path: join(home, '.augment', 'skills') },
    { source: 'custom', sourceLabel: 'IBM Bob', path: join(home, '.bob', 'skills') },
    { source: 'claude-code', sourceLabel: 'Claude Code', path: join(claudeHome, 'skills') },
    {
      source: 'openclaw',
      sourceLabel: 'OpenClaw',
      path: firstExistingPath([
        join(home, '.openclaw', 'skills'),
        join(home, '.clawdbot', 'skills'),
        join(home, '.moltbot', 'skills')
      ])
    },
    { source: 'custom', sourceLabel: 'CodeArts Agent', path: join(home, '.codeartsdoer', 'skills') },
    { source: 'custom', sourceLabel: 'CodeBuddy', path: join(home, '.codebuddy', 'skills') },
    { source: 'custom', sourceLabel: 'Codemaker', path: join(home, '.codemaker', 'skills') },
    { source: 'custom', sourceLabel: 'Code Studio', path: join(home, '.codestudio', 'skills') },
    { source: 'codex', sourceLabel: 'Codex', path: join(codexHome, 'skills') },
    { source: 'custom', sourceLabel: 'Command Code', path: join(home, '.commandcode', 'skills') },
    { source: 'custom', sourceLabel: 'Continue', path: join(home, '.continue', 'skills') },
    { source: 'custom', sourceLabel: 'Cortex Code', path: join(home, '.snowflake', 'cortex', 'skills') },
    { source: 'custom', sourceLabel: 'Crush', path: join(configHome, 'crush', 'skills') },
    { source: 'cursor', sourceLabel: 'Cursor', path: join(home, '.cursor', 'skills') },
    { source: 'custom', sourceLabel: 'Deep Agents', path: join(home, '.deepagents', 'agent', 'skills') },
    { source: 'custom', sourceLabel: 'Devin', path: join(configHome, 'devin', 'skills') },
    { source: 'custom', sourceLabel: 'Droid', path: join(home, '.factory', 'skills') },
    { source: 'custom', sourceLabel: 'Firebender', path: join(home, '.firebender', 'skills') },
    { source: 'custom', sourceLabel: 'ForgeCode', path: join(home, '.forge', 'skills') },
    { source: 'gemini', sourceLabel: 'Gemini CLI', path: join(home, '.gemini', 'skills') },
    { source: 'copilot', sourceLabel: 'GitHub Copilot', path: join(home, '.copilot', 'skills') },
    { source: 'custom', sourceLabel: 'Goose', path: join(configHome, 'goose', 'skills') },
    { source: 'hermes', sourceLabel: 'Hermes', path: join(hermesHome, 'skills') },
    { source: 'custom', sourceLabel: 'inference.sh', path: join(home, '.inferencesh', 'skills') },
    { source: 'custom', sourceLabel: 'iFlow CLI', path: join(home, '.iflow', 'skills') },
    { source: 'custom', sourceLabel: 'Jazz', path: join(home, '.jazz', 'skills') },
    { source: 'custom', sourceLabel: 'Junie', path: join(home, '.junie', 'skills') },
    { source: 'custom', sourceLabel: 'Kilo Code', path: join(home, '.kilocode', 'skills') },
    { source: 'custom', sourceLabel: 'Kiro CLI', path: join(home, '.kiro', 'skills') },
    { source: 'custom', sourceLabel: 'Kode', path: join(home, '.kode', 'skills') },
    { source: 'custom', sourceLabel: 'Lingma', path: join(home, '.lingma', 'skills') },
    { source: 'custom', sourceLabel: 'MCPJam', path: join(home, '.mcpjam', 'skills') },
    { source: 'custom', sourceLabel: 'Mistral Vibe', path: join(vibeHome, 'skills') },
    { source: 'custom', sourceLabel: 'Moxby', path: join(home, '.moxby', 'skills') },
    { source: 'custom', sourceLabel: 'Mux', path: join(home, '.mux', 'skills') },
    { source: 'custom', sourceLabel: 'OpenCode', path: join(configHome, 'opencode', 'skills') },
    { source: 'custom', sourceLabel: 'OpenHands', path: join(home, '.openhands', 'skills') },
    { source: 'custom', sourceLabel: 'Ona', path: join(home, '.ona', 'skills') },
    { source: 'custom', sourceLabel: 'Pi', path: join(home, '.pi', 'agent', 'skills') },
    {
      source: 'custom',
      sourceLabel: 'Qoder',
      path: firstExistingPath([join(home, '.qoder', 'skills'), join(home, '.qoder-cn', 'skills')])
    },
    { source: 'qwen', sourceLabel: 'Qwen Code', path: join(home, '.qwen', 'skills') },
    { source: 'custom', sourceLabel: 'Reasonix', path: join(home, '.reasonix', 'skills') },
    { source: 'custom', sourceLabel: 'Roo Code', path: join(home, '.roo', 'skills') },
    { source: 'custom', sourceLabel: 'Rovo Dev', path: join(home, '.rovodev', 'skills') },
    { source: 'custom', sourceLabel: 'Tabnine CLI', path: join(home, '.tabnine', 'agent', 'skills') },
    { source: 'custom', sourceLabel: 'Terramind', path: join(home, '.terramind', 'skills') },
    { source: 'custom', sourceLabel: 'Tinycloud', path: join(home, '.tinycloud', 'skills') },
    {
      source: 'custom',
      sourceLabel: 'Trae',
      path: firstExistingPath([join(home, '.trae', 'skills'), join(home, '.trae-cn', 'skills')])
    },
    { source: 'custom', sourceLabel: 'Windsurf', path: join(home, '.codeium', 'windsurf', 'skills') },
    { source: 'custom', sourceLabel: 'Zencoder', path: join(home, '.zencoder', 'skills') },
    { source: 'custom', sourceLabel: 'Neovate', path: join(home, '.neovate', 'skills') },
    { source: 'custom', sourceLabel: 'Pochi', path: join(home, '.pochi', 'skills') },
    { source: 'custom', sourceLabel: 'AdaL', path: join(home, '.adal', 'skills') }
  ];

  return uniqueSpecs(
    targets.map((target) => ({
      ...target,
      scope: 'user',
      kind: 'skills'
    }))
  );
}

function mcpRoots(paths: MonadPaths, home: string): RootSpec[] {
  return uniqueSpecs([
    { source: 'monad', sourceLabel: 'Monad config', scope: 'user', kind: 'mcpServers', path: paths.config },
    { source: 'monad', sourceLabel: 'Monad MCP atoms', scope: 'user', kind: 'mcpServers', path: paths.mcp },
    {
      source: 'codex',
      sourceLabel: 'Codex',
      scope: 'user',
      kind: 'mcpServers',
      path: join(home, '.codex', 'config.toml')
    },
    {
      source: 'claude-code',
      sourceLabel: 'Claude Code',
      scope: 'user',
      kind: 'mcpServers',
      path: join(home, '.claude', 'settings.json')
    },
    {
      source: 'claude-code',
      sourceLabel: 'Claude Desktop',
      scope: 'user',
      kind: 'mcpServers',
      path: join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    },
    {
      source: 'gemini',
      sourceLabel: 'Gemini CLI',
      scope: 'user',
      kind: 'mcpServers',
      path: join(home, '.gemini', 'settings.json')
    },
    {
      source: 'cursor',
      sourceLabel: 'Cursor',
      scope: 'user',
      kind: 'mcpServers',
      path: join(home, '.cursor', 'mcp.json')
    },
    {
      source: 'vscode',
      sourceLabel: 'VS Code',
      scope: 'user',
      kind: 'mcpServers',
      path: join(home, '.vscode', 'mcp.json')
    }
  ]);
}

function sourceForAgentProvider(provider: ExternalAgentProvider): CapabilityInventorySource {
  switch (provider) {
    case 'codex':
      return 'codex';
    case 'claude-code':
      return 'claude-code';
    case 'gemini':
      return 'gemini';
    case 'qwen':
      return 'qwen';
    case 'openclaw':
      return 'openclaw';
    case 'hermes':
      return 'hermes';
    default:
      return 'custom';
  }
}

function agentScope(scope: string): CapabilityInventoryScope {
  if (scope === 'global') return 'user';
  if (scope === 'workspace') return 'workspace';
  if (scope === 'profile') return 'user';
  return 'unknown';
}

function agentRoots(): RootSpec[] {
  return providerConfigRoots('agents');
}

function modelProviderRoots(): RootSpec[] {
  return providerConfigRoots('modelProviders');
}

function providerConfigRoots(kind: Extract<CapabilityInventoryRoot['kind'], 'agents' | 'modelProviders'>): RootSpec[] {
  return uniqueSpecs(
    listExternalAgentProviderAdapters().flatMap((adapter) => {
      const candidates = adapter.settingsImport?.detect(defaultBinProbes) ?? [];
      return candidates.map((candidate) => ({
        source: sourceForAgentProvider(adapter.provider),
        sourceLabel: candidate.label,
        scope: agentScope(candidate.scope),
        kind,
        path: candidate.path,
        provider: adapter.provider
      }));
    })
  );
}

export function createCapabilityInventoryModule(paths: MonadPaths) {
  return {
    async list(): Promise<CapabilityInventoryResponse> {
      const home = homedir();
      const specs = [...skillRoots(paths, home), ...mcpRoots(paths, home), ...agentRoots(), ...modelProviderRoots()];
      const roots = await Promise.all(specs.map(rootStatus));
      const items: CapabilityInventoryItem[] = [];
      const warnings: string[] = [];
      for (const [index, root] of roots.entries()) {
        if (!root.exists) continue;
        const spec = specs[index];
        if (!spec) continue;
        try {
          if (spec.kind === 'skills') items.push(...(await scanSkillRoot(spec)));
          else if (spec.kind === 'mcpServers') items.push(...(await scanMcpRoot(spec)));
          else if (spec.kind === 'agents') items.push(...(await scanAgentRoot(spec)));
          else items.push(...(await scanModelProviderRoot(spec)));
        } catch (err) {
          warnings.push(`${root.path}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      return { roots, items, warnings };
    },

    async openLocation(req: CapabilityInventoryOpenLocationRequest): Promise<{ ok: true }> {
      const home = homedir();
      const specs = [...skillRoots(paths, home), ...mcpRoots(paths, home), ...agentRoots(), ...modelProviderRoots()];
      const spec = specs.find((candidate) => rootMatchesRequest(candidate, req));
      if (!spec) throw new Error('Unknown capability inventory location');
      await openNativePath(detectPathForRoot(spec));
      return { ok: true };
    }
  };
}
