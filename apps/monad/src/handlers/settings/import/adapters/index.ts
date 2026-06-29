import type { McpServerConfig, ModelProfile, Provider } from '@monad/home';
import type { ImportSettingsCategory, ImportSettingsRequest, ImportSettingsRisk } from '@monad/protocol';
import type { KnownSource, ParsedImport, PlannedItem } from '../types.ts';

import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { ModelProviderType } from '@monad/protocol';

import { findSkillDirs, parseSkillMd } from '@/store/home/skills.ts';

const MAX_CONFIG_BYTES = 5 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : undefined;
}

function asRecordArray(value: unknown): Record<string, unknown>[] | undefined {
  return Array.isArray(value) && value.every(isRecord) ? value : undefined;
}

function getPath(root: unknown, path: string[]): unknown {
  let cur = root;
  for (const part of path) {
    if (!isRecord(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function recordAt(root: unknown, path: string[]): Record<string, unknown> | undefined {
  const value = getPath(root, path);
  return isRecord(value) ? value : undefined;
}

function parseJsonOrYaml(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return Bun.YAML.parse(text);
  }
}

function expandPath(inputPath: string): string {
  let out = inputPath;
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) {
    out = join(homedir(), out.slice(2));
  }
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (match, name) => process.env[name] ?? match);
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, bare) => {
    const name = (braced ?? bare) as string;
    return process.env[name] ?? match;
  });
  return out;
}

async function pathInfo(inputPath: string): Promise<{ root: string; isDir: boolean }> {
  const expanded = expandPath(inputPath);
  const candidates = new Map<string, string>();
  candidates.set(expanded, resolve(expanded));
  const forward = expanded.replace(/\\/g, '/');
  if (forward !== expanded) candidates.set(forward, resolve(forward));
  const backward = expanded.replace(/\//g, '\\');
  if (backward !== expanded) candidates.set(backward, resolve(backward));

  let lastError: unknown;
  for (const root of candidates.values()) {
    try {
      const s = await stat(root);
      return { root, isDir: s.isDirectory() };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
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
    const file = Bun.file(path);
    const text = await file.text();
    return { path, data: extname(path) === '.toml' ? Bun.TOML.parse(text) : parseJsonOrYaml(text) };
  }
  return null;
}

async function readFirstConfigObject(
  root: string,
  isDir: boolean,
  namesByDir: string[][]
): Promise<{ path: string; data: unknown } | null> {
  for (const names of namesByDir) {
    const cfg = await readConfigObject(root, isDir, names);
    if (cfg) return cfg;
  }
  return null;
}

function itemId(category: ImportSettingsCategory, target: string): string {
  return `${category}:${target}`.replace(/[^A-Za-z0-9:_./-]+/g, '-');
}

function addItem(items: PlannedItem[], input: Omit<PlannedItem, 'id' | 'risk'> & { risk?: ImportSettingsRisk }): void {
  items.push({ id: itemId(input.category, input.target), risk: input.risk ?? 'low', ...input });
}

function envValue(value: string): string {
  const match = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
  if (match) return value;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? `\${env:${value}}` : value;
}

function mcpFromRecord(name: string, raw: unknown): McpServerConfig | null {
  if (!isRecord(raw)) return null;
  const transport = asString(raw.transport);
  const command = asString(raw.command);
  const args = asStringArray(raw.args);
  const env = isRecord(raw.env)
    ? (Object.fromEntries(Object.entries(raw.env).filter(([, v]) => typeof v === 'string')) as Record<string, string>)
    : undefined;
  const url = asString(raw.url) ?? asString(raw.serverUrl) ?? asString(raw.endpoint);
  const headers = isRecord(raw.headers)
    ? (Object.fromEntries(Object.entries(raw.headers).filter(([, v]) => typeof v === 'string')) as Record<
        string,
        string
      >)
    : undefined;
  const enabled = asBoolean(raw.enabled) ?? (asBoolean(raw.disabled) === undefined ? true : !asBoolean(raw.disabled));
  const autoApprove =
    asStringArray(raw.autoApprove) ?? asStringArray(raw.allowedTools) ?? asStringArray(raw.autoApproveTools) ?? [];
  const requestTimeoutMs =
    typeof raw.requestTimeoutMs === 'number'
      ? raw.requestTimeoutMs
      : typeof raw.timeout === 'number'
        ? raw.timeout
        : undefined;
  if (url || transport === 'sse' || transport === 'http') {
    if (!url) return null;
    return {
      name,
      transport: 'http',
      url,
      auth: headers ? { mode: 'headers', headers } : { mode: 'none' },
      ...(requestTimeoutMs ? { requestTimeoutMs } : {}),
      enabled,
      trust: { autoApproveTools: autoApprove, hostEscape: false }
    };
  }
  if (!command) return null;
  return {
    name,
    transport: 'stdio',
    command,
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
    ...(asString(raw.cwd) ? { cwd: asString(raw.cwd) } : {}),
    ...(requestTimeoutMs ? { requestTimeoutMs } : {}),
    enabled,
    trust: { autoApproveTools: autoApprove, hostEscape: false }
  };
}

function mcpEntries(raw: unknown): Array<[string, unknown]> {
  if (isRecord(raw)) return Object.entries(raw);
  const list = asRecordArray(raw);
  if (!list) return [];
  return list.flatMap((entry, index): Array<[string, unknown]> => {
    const name = asString(entry.name) ?? asString(entry.id) ?? `server-${index + 1}`;
    return [[name, entry]];
  });
}

async function addSkillItems(items: PlannedItem[], source: string, dir: string): Promise<void> {
  try {
    if (!(await stat(dir)).isDirectory()) return;
  } catch {
    return;
  }
  let dirs: string[] = [];
  try {
    dirs = await findSkillDirs(dir);
  } catch (err) {
    addItem(items, {
      category: 'skills',
      source,
      target: dir,
      action: 'skip',
      reason: err instanceof Error ? err.message : String(err),
      payload: { kind: 'manual' }
    });
    return;
  }
  for (const skillDir of dirs) {
    try {
      const parsed = parseSkillMd(await Bun.file(join(skillDir, 'SKILL.md')).text());
      addItem(items, {
        category: 'skills',
        source: `${source}:${skillDir}`,
        target: parsed.frontmatter.name,
        action: 'add',
        reason: 'valid SKILL.md can be installed as a global monad skill',
        payload: { kind: 'skill', dir: skillDir, name: parsed.frontmatter.name },
        summary: parsed.frontmatter.description
      });
    } catch (err) {
      addItem(items, {
        category: 'skills',
        source: `${source}:${skillDir}`,
        target: basename(skillDir),
        action: 'skip',
        reason: err instanceof Error ? err.message : String(err),
        payload: { kind: 'manual' }
      });
    }
  }
}

function inferProviderForModel(model: string): Provider | null {
  if (/^gpt-|^o\d|^chatgpt-/i.test(model)) return { id: 'openai', label: 'OpenAI', type: ModelProviderType.OpenAI };
  if (/claude/i.test(model)) return { id: 'anthropic', label: 'Anthropic', type: ModelProviderType.Anthropic };
  if (/gemini/i.test(model)) return { id: 'google', label: 'Google', type: ModelProviderType.Google };
  if (/deepseek/i.test(model)) return { id: 'deepseek', label: 'DeepSeek', type: ModelProviderType.DeepSeek };
  if (/qwen|qwq/i.test(model)) return { id: 'openrouter', label: 'OpenRouter', type: ModelProviderType.OpenRouter };
  return null;
}

function providerTypeFromName(name: string): ModelProviderType | null {
  const normalized = name.toLowerCase().replace(/[_\s]+/g, '-');
  const direct = Object.values(ModelProviderType).find((p) => p === normalized);
  if (direct) return direct;
  if (normalized === 'anthropic') return ModelProviderType.Anthropic;
  if (normalized === 'openai') return ModelProviderType.OpenAI;
  if (normalized === 'google' || normalized === 'gemini') return ModelProviderType.Google;
  if (normalized === 'openrouter') return ModelProviderType.OpenRouter;
  if (normalized === 'ollama') return ModelProviderType.Ollama;
  return null;
}

function providerFromId(id: string, raw?: unknown): Provider | null {
  const type = providerTypeFromName(id);
  if (!type) return null;
  const baseUrl = isRecord(raw)
    ? (asString(raw.baseUrl) ?? asString(raw.base_url) ?? asString(raw.api_base))
    : undefined;
  return {
    id,
    label: isRecord(raw) ? (asString(raw.label) ?? asString(raw.name) ?? id) : id,
    type,
    ...(baseUrl ? { baseUrl } : {})
  };
}

function addModelProfileFromExternal(
  items: PlannedItem[],
  source: string,
  targetPrefix: string,
  model: string,
  providerId?: string,
  makeDefault = false
): void {
  const provider = providerId ? providerFromId(providerId) : inferProviderForModel(model);
  if (!provider) {
    addItem(items, {
      category: 'modelProfiles',
      source,
      target: `${targetPrefix}.default`,
      action: 'manual',
      reason: `model "${model}" does not identify a supported monad provider`,
      payload: { kind: 'manual' },
      risk: 'medium',
      summary: providerId ? `provider=${providerId} model=${model}` : `model=${model}`
    });
    return;
  }
  const modelId = model.includes('/') ? (model.split('/').pop() ?? model) : model;
  const profile: ModelProfile = {
    alias: `${targetPrefix}-${modelId}`.replace(/[^A-Za-z0-9_.-]+/g, '-'),
    routes: { chat: { provider: provider.id, modelId } },
    params: {},
    fallbacks: []
  };
  addItem(items, {
    category: 'modelProviders',
    source,
    target: provider.id,
    action: 'add',
    reason: `inferred provider "${provider.id}" from external model settings`,
    payload: { kind: 'modelProvider', provider }
  });
  addItem(items, {
    category: 'modelProfiles',
    source,
    target: profile.alias,
    action: 'add',
    reason: 'external default model can be represented as a monad model profile',
    payload: { kind: 'modelProfile', profile, makeDefault }
  });
}

async function parseCodex(inputPath: string): Promise<ParsedImport> {
  const { root, isDir } = await pathInfo(inputPath);
  const items: PlannedItem[] = [];
  const warnings: string[] = [];
  const cfg = await readFirstConfigObject(root, isDir, [['config.toml'], ['browser/config.toml']]);
  if (cfg && isRecord(cfg.data)) {
    const model = asString(cfg.data.model);
    if (model) {
      addModelProfileFromExternal(items, `${cfg.path}:model`, 'codex', model, undefined, true);
      const effort = asString(cfg.data.model_reasoning_effort);
      if (effort === 'minimal' || effort === 'low' || effort === 'medium' || effort === 'high') {
        const item = items.find((i) => i.category === 'modelProfiles' && i.target === `codex-${model}`);
        if (item?.payload.kind === 'modelProfile') item.payload.profile.params.reasoningEffort = effort;
      }
    }
    for (const [name, raw] of Object.entries(recordAt(cfg.data, ['mcp_servers']) ?? {})) {
      const server = mcpFromRecord(name, raw);
      const timeoutNote =
        isRecord(raw) && raw.startup_timeout_sec ? '; startup_timeout_sec is not requestTimeoutMs' : '';
      addItem(items, {
        category: 'mcpServers',
        source: `${cfg.path}:mcp_servers.${name}`,
        target: name,
        action: server ? 'add' : 'manual',
        reason: server ? `Codex MCP server maps to monad mcpServers${timeoutNote}` : 'Unsupported Codex MCP shape',
        payload: server ? { kind: 'mcpServer', server } : { kind: 'manual' },
        risk: server?.transport === 'stdio' ? 'medium' : 'low',
        summary: server ? (server.transport === 'stdio' ? server.command : server.url) : undefined
      });
    }
    const sandbox = asString(cfg.data.sandbox_mode);
    if (sandbox) {
      const mode = sandbox === 'danger-full-access' ? 'unrestricted' : 'workspace';
      addItem(items, {
        category: 'sandbox',
        source: `${cfg.path}:sandbox_mode`,
        target: 'agent.sandbox.mode',
        action: 'add',
        reason: `Codex sandbox_mode can be mapped to monad sandbox mode "${mode}"`,
        payload: { kind: 'sandbox', mode },
        risk: mode === 'unrestricted' ? 'high' : 'medium'
      });
    }
    const approval = asString(cfg.data.approval_policy);
    if (approval) {
      addItem(items, {
        category: 'approvals',
        source: `${cfg.path}:approval_policy`,
        target: 'agent.approvals',
        action: 'manual',
        reason: 'Codex approval policy is coarser than monad operator allow/ask/deny lists',
        payload: { kind: 'approval', approvalPolicy: approval },
        risk: 'high'
      });
    }
    if (isRecord(cfg.data.plugins) || isRecord(cfg.data.apps)) {
      addItem(items, {
        category: 'plugins',
        source: cfg.path,
        target: 'plugins/apps',
        action: 'manual',
        reason: 'Codex plugins/apps/connectors are not equivalent to monad skills or MCP servers',
        payload: { kind: 'manual' },
        risk: 'medium'
      });
    }
  } else {
    warnings.push('No Codex config.toml found at the provided path.');
  }
  if (isDir) await addSkillItems(items, 'codex:skills', join(root, 'skills'));
  return { from: 'codex', path: root, items, warnings };
}

function parseClaudeSubagent(md: string): { name: string; description?: string; model?: string; prompt: string } {
  const text = md.replace(/^﻿/, '').trimStart();
  const fence = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!fence) throw new Error('No YAML frontmatter found');
  const front = Bun.YAML.parse(fence[1] ?? '');
  const name = isRecord(front) ? asString(front.name) : undefined;
  if (!isRecord(front) || !name) throw new Error('Frontmatter is missing name');
  return {
    name,
    description: asString(front.description),
    model: asString(front.model),
    prompt: text.slice(fence[0].length).trim()
  };
}

async function addClaudeAgents(items: PlannedItem[], root: string): Promise<void> {
  const agentsDir = join(root, 'agents');
  try {
    if (!(await stat(agentsDir)).isDirectory()) return;
  } catch {
    return;
  }
  for (const entry of await readdir(agentsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const path = join(agentsDir, entry.name);
    try {
      const agent = parseClaudeSubagent(await Bun.file(path).text());
      addItem(items, {
        category: 'agents',
        source: path,
        target: agent.name,
        action: 'add',
        reason: 'Claude Code subagent persona maps to a monad agent; Claude tools are not imported',
        payload: { kind: 'agent', ...agent, framework: 'custom' },
        summary: agent.description
      });
    } catch (err) {
      addItem(items, {
        category: 'agents',
        source: path,
        target: basename(path, '.md'),
        action: 'skip',
        reason: err instanceof Error ? err.message : String(err),
        payload: { kind: 'manual' }
      });
    }
  }
}

async function parseClaudeCode(inputPath: string): Promise<ParsedImport> {
  const { root, isDir } = await pathInfo(inputPath);
  const items: PlannedItem[] = [];
  const warnings: string[] = [];
  const cfg = await readFirstConfigObject(root, isDir, [['settings.json'], ['.claude/settings.json']]);
  if (cfg && isRecord(cfg.data)) {
    for (const [name, raw] of Object.entries(recordAt(cfg.data, ['mcpServers']) ?? {})) {
      const server = mcpFromRecord(name, raw);
      addItem(items, {
        category: 'mcpServers',
        source: `${cfg.path}:mcpServers.${name}`,
        target: name,
        action: server ? 'add' : 'manual',
        reason: server ? 'Claude Code MCP server maps to monad mcpServers' : 'Unsupported Claude Code MCP shape',
        payload: server ? { kind: 'mcpServer', server } : { kind: 'manual' },
        risk: server?.transport === 'stdio' ? 'medium' : 'low',
        summary: server ? (server.transport === 'stdio' ? server.command : server.url) : undefined
      });
    }
    if (isRecord(cfg.data.env)) {
      for (const [name, value] of Object.entries(cfg.data.env)) {
        if (typeof value !== 'string') continue;
        addItem(items, {
          category: 'credentials',
          source: `${cfg.path}:env.${name}`,
          target: `env:${name}`,
          action: 'manual',
          reason: `secret-bearing env value can be referenced as ${envValue(name)} but is not imported as a raw credential`,
          payload: { kind: 'manual' },
          risk: 'high',
          summary: envValue(name)
        });
      }
    }
  } else {
    warnings.push('No Claude Code settings.json found at the provided path.');
  }
  if (isDir) await addClaudeAgents(items, root);
  return { from: 'claude-code', path: root, items, warnings };
}

function providerFromRecord(name: string, raw: unknown): Provider | null {
  if (!isRecord(raw)) return null;
  const type = providerTypeFromName(asString(raw.type) ?? asString(raw.provider) ?? name);
  const known = Object.values(ModelProviderType).find((p) => p === type);
  if (!known) return null;
  const baseUrl = asString(raw.baseUrl) ?? asString(raw.base_url);
  return {
    id: asString(raw.id) ?? name,
    label: asString(raw.label) ?? name,
    type: known,
    ...(baseUrl ? { baseUrl } : {})
  };
}

function configNamesForFramework(from: 'hermes' | 'openclaw'): string[][] {
  return from === 'hermes'
    ? [['config.yaml'], ['config.yml'], ['config.json'], ['hermes.yaml'], ['hermes.json']]
    : [['openclaw.json'], ['config.json'], ['config.yaml'], ['config.yml'], ['openclaw.yaml'], ['openclaw.yml']];
}

async function parseFramework(inputPath: string, from: 'hermes' | 'openclaw'): Promise<ParsedImport> {
  const { root, isDir } = await pathInfo(inputPath);
  const items: PlannedItem[] = [];
  const warnings: string[] = [];
  const cfg = await readFirstConfigObject(root, isDir, configNamesForFramework(from));
  if (!cfg || !isRecord(cfg.data)) {
    warnings.push(`No ${from} config file found at the provided path.`);
  } else {
    const mcpServers =
      getPath(cfg.data, ['mcp_servers']) ??
      getPath(cfg.data, ['mcpServers']) ??
      getPath(cfg.data, ['mcp', 'servers']) ??
      {};
    for (const [name, raw] of mcpEntries(mcpServers)) {
      const server = mcpFromRecord(name, raw);
      addItem(items, {
        category: 'mcpServers',
        source: `${cfg.path}:mcp.${name}`,
        target: name,
        action: server ? 'add' : 'manual',
        reason: server ? `${from} MCP server maps to monad mcpServers` : `Unsupported ${from} MCP shape`,
        payload: server ? { kind: 'mcpServer', server } : { kind: 'manual' },
        risk: server?.transport === 'stdio' ? 'medium' : 'low'
      });
    }
    const providers = isRecord(cfg.data.providers)
      ? cfg.data.providers
      : isRecord(cfg.data.models)
        ? cfg.data.models
        : {};
    for (const [name, raw] of Object.entries(providers)) {
      const provider = providerFromRecord(name, raw);
      if (provider) {
        addItem(items, {
          category: 'modelProviders',
          source: `${cfg.path}:providers.${name}`,
          target: provider.id,
          action: 'add',
          reason: `${from} provider has a direct monad provider type`,
          payload: { kind: 'modelProvider', provider }
        });
      }
    }
    const model =
      asString(getPath(cfg.data, ['model', 'default'])) ?? asString(cfg.data.default_model) ?? asString(cfg.data.model);
    const providerId =
      asString(getPath(cfg.data, ['model', 'provider'])) ??
      (model?.includes('/') ? model.split('/')[0] : undefined) ??
      asString(cfg.data.provider);
    if (model) addModelProfileFromExternal(items, `${cfg.path}:model`, from, model, providerId);
    if (
      cfg.data.workflow ||
      cfg.data.workflows ||
      cfg.data.state ||
      cfg.data.database ||
      cfg.data.runtime_plugins ||
      cfg.data.plugins
    ) {
      addItem(items, {
        category: 'plugins',
        source: cfg.path,
        target: `${from}:runtime`,
        action: 'manual',
        reason: `${from} workflow/state/runtime plugin concepts are not monad settings`,
        payload: { kind: 'manual' },
        risk: 'medium'
      });
    }
  }
  if (isDir) await addSkillItems(items, `${from}:skills`, join(root, 'skills'));
  return { from, path: root, items, warnings };
}

async function parseGenericMcpConfig(inputPath: string, from: KnownSource): Promise<ParsedImport> {
  const { root, isDir } = await pathInfo(inputPath);
  const items: PlannedItem[] = [];
  const warnings: string[] = [];
  const cfg = await readFirstConfigObject(root, isDir, [
    ['settings.json'],
    ['mcp.json'],
    ['config.json'],
    ['config.yaml'],
    ['config.yml']
  ]);
  if (!cfg || !isRecord(cfg.data)) {
    warnings.push(`No ${from} settings/config file found at the provided path.`);
    return { from, path: root, items, warnings };
  }
  const mcpServers =
    getPath(cfg.data, ['mcpServers']) ??
    getPath(cfg.data, ['mcp', 'servers']) ??
    getPath(cfg.data, ['mcp_servers']) ??
    {};
  for (const [name, raw] of mcpEntries(mcpServers)) {
    const server = mcpFromRecord(name, raw);
    addItem(items, {
      category: 'mcpServers',
      source: `${cfg.path}:mcp.${name}`,
      target: name,
      action: server ? 'add' : 'manual',
      reason: server ? `${from} MCP server maps to monad mcpServers` : `Unsupported ${from} MCP shape`,
      payload: server ? { kind: 'mcpServer', server } : { kind: 'manual' },
      risk: server?.transport === 'stdio' ? 'medium' : 'low',
      summary: server ? (server.transport === 'stdio' ? server.command : server.url) : undefined
    });
  }
  if (cfg.data.workflows || cfg.data.plugins || cfg.data.extensions || cfg.data.commands) {
    addItem(items, {
      category: 'plugins',
      source: cfg.path,
      target: `${from}:runtime`,
      action: 'manual',
      reason: `${from} workflow/plugin/runtime concepts are not monad settings`,
      payload: { kind: 'manual' },
      risk: 'medium'
    });
  }
  return { from, path: root, items, warnings };
}

async function detectSource(inputPath: string): Promise<KnownSource> {
  const { root, isDir } = await pathInfo(inputPath);
  const pathHint = inputPath.replace(/\\/g, '/');
  const cfg = await readFirstConfigObject(root, isDir, [
    ['openclaw.json'],
    ['settings.json'],
    ['config.toml'],
    ['config.yaml'],
    ['config.yml'],
    ['config.json']
  ]);
  if (cfg && isRecord(cfg.data)) {
    const filename = basename(cfg.path).toLowerCase();
    const extension = extname(cfg.path).toLowerCase();
    if (filename === 'openclaw.json') return 'openclaw';
    if (/claude[-_\s]?desktop|claude_desktop_config/i.test(pathHint)) return 'claude-desktop';
    if (/open-?claw|opencalw/i.test(pathHint)) return 'openclaw';
    if (/hermes/i.test(pathHint)) return 'hermes';
    if (/cursor/i.test(pathHint)) return 'cursor';
    if (/vscode|code\/user/i.test(pathHint)) return 'vscode';
    if (/aider/i.test(pathHint)) return 'aider';
    if (/continue/i.test(pathHint)) return 'continue';
    if (/roo|cline/i.test(pathHint)) return 'roo-code';
    if (filename === 'settings.json') return 'claude-code';
    if (extension === '.toml') return 'codex';
    if (recordAt(cfg.data, ['mcpServers']) || cfg.data.hooks || cfg.data.agentPushNotifEnabled !== undefined) {
      return 'claude-code';
    }
    if (recordAt(cfg.data, ['mcp', 'servers']) || cfg.data.state || cfg.data.database) return 'openclaw';
    if (extension === '.yaml' || extension === '.yml') return 'hermes';
    if (recordAt(cfg.data, ['mcp_servers']) || cfg.data.sandbox_mode || cfg.data.approval_policy) return 'codex';
    if (recordAt(cfg.data, ['mcp_servers']) || recordAt(cfg.data, ['model'])) return 'hermes';
  }
  if (/claude[-_\s]?desktop|claude_desktop_config/i.test(pathHint)) return 'claude-desktop';
  if (/claude/i.test(pathHint)) return 'claude-code';
  if (/hermes/i.test(pathHint)) return 'hermes';
  if (/open-?claw|opencalw/i.test(pathHint)) return 'openclaw';
  if (/cursor/i.test(pathHint)) return 'cursor';
  if (/vscode|code\/user/i.test(pathHint)) return 'vscode';
  if (/aider/i.test(pathHint)) return 'aider';
  if (/continue/i.test(pathHint)) return 'continue';
  if (/roo|cline/i.test(pathHint)) return 'roo-code';
  return 'codex';
}

export async function parseSource(req: ImportSettingsRequest): Promise<ParsedImport> {
  const from = req.from === 'auto' ? await detectSource(req.path) : req.from;
  switch (from) {
    case 'codex':
      return parseCodex(req.path);
    case 'claude-code':
      return parseClaudeCode(req.path);
    case 'hermes':
      return parseFramework(req.path, 'hermes');
    case 'openclaw':
      return parseFramework(req.path, 'openclaw');
    case 'cursor':
    case 'claude-desktop':
    case 'vscode':
    case 'aider':
    case 'continue':
    case 'roo-code':
      return parseGenericMcpConfig(req.path, from);
  }
}
