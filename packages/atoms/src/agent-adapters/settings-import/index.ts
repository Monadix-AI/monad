import type {
  AdapterMigrationSource,
  MeshAgentProvider,
  MeshAgentSettingsImportItem,
  MeshAgentSettingsImportPreview,
  MeshAgentView
} from '@monad/protocol';
import type { MeshAgentSettingsImport } from '@monad/sdk-atom';

import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { ModelProviderType } from '@monad/protocol';

import { meshAgentSettingsImportItemHash, publicItemWithoutHash } from './settings-import-hash.ts';
import {
  addChannelItems,
  addModelItems,
  addMonadAgentItem,
  addSkillItems,
  agentItem,
  defaultCandidates,
  mergePreview,
  previewItem,
  sourcesForRequest,
  targetForScope
} from './settings-import-items.ts';
import { addMcpItems } from './settings-import-mcp.ts';
import { asString, asStringArray, isRecord, pathInfo, readConfigObject } from './settings-import-parse.ts';

async function recognizesConfig(
  path: string,
  names: string[],
  accept: (data: Record<string, unknown>, file: string) => boolean
): Promise<boolean> {
  try {
    const { root, isDir } = await pathInfo(path);
    const cfg = await readConfigObject(root, isDir, names);
    return !!cfg && isRecord(cfg.data) && accept(cfg.data, cfg.path.replaceAll('\\', '/'));
  } catch {
    return false;
  }
}

async function addClaudeAgents(items: MeshAgentSettingsImportItem[], root: string): Promise<void> {
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
      const text = (await Bun.file(path).text()).replace(/^﻿/, '').trimStart();
      const fence = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
      if (!fence) throw new Error('No YAML frontmatter found');
      const front = Bun.YAML.parse(fence[1] ?? '');
      const name = isRecord(front) ? asString(front.name) : undefined;
      if (!isRecord(front) || !name) throw new Error('Frontmatter is missing name');
      items.push(
        previewItem(
          'agents',
          path,
          name,
          'Claude Code subagent persona maps to a Monad agent; Claude tools are not imported',
          {
            kind: 'agent',
            name,
            description: asString(front.description),
            model: asString(front.model),
            prompt: text.slice(fence[0].length).trim(),
            framework: 'custom'
          },
          { summary: asString(front.description) }
        )
      );
    } catch (error) {
      items.push(
        previewItem(
          'agents',
          path,
          basename(path, '.md'),
          error instanceof Error ? error.message : String(error),
          { kind: 'manual' },
          { action: 'skip' }
        )
      );
    }
  }
}

export { meshAgentSettingsImportItemHash };

export function createCodexSettingsImport(): MeshAgentSettingsImport {
  return {
    recognizes: (path) =>
      recognizesConfig(path, ['config.toml', 'browser/config.toml'], (_data, file) => file.endsWith('.toml')),
    detect(probes) {
      return defaultCandidates('codex', 'Codex', [{ path: join(homedir(), '.codex'), scope: 'global' }], probes);
    },
    async preview({ path, sources }): Promise<MeshAgentSettingsImportPreview> {
      const warnings: string[] = [];
      const normalizedSources: AdapterMigrationSource[] = [];
      const items: MeshAgentSettingsImportItem[] = [];
      for (const source of sourcesForRequest(path, sources)) {
        const { root, isDir } = await pathInfo(source.path);
        const normalizedSource = { ...source, path: root };
        normalizedSources.push(normalizedSource);
        const cfg = await readConfigObject(root, isDir, ['config.toml', 'browser/config.toml']);
        const data = isRecord(cfg?.data) ? cfg.data : {};
        if (!cfg) warnings.push(`No Codex config.toml found at ${root}.`);
        const model = asString(data.model);
        const target = targetForScope('codex', source.scope);
        const agent: MeshAgentView = {
          name: target,
          provider: 'codex',
          productIcon: 'codex',
          command: 'codex',
          args: [],
          ...(model ? { modelOptions: [model] } : {}),
          enabled: true,
          allowAutopilot: false,
          approvalOwnership: 'provider-owned'
        };
        items.push(agentItem(cfg?.path ?? root, target, agent, model ? `model=${model}` : undefined));
        if (model && cfg) {
          const profile = {
            alias: `codex-${model}`,
            routes: { chat: { provider: 'openai', modelId: model } },
            params: {},
            fallbacks: []
          };
          const effort = asString(data.model_reasoning_effort);
          if (effort === 'minimal' || effort === 'low' || effort === 'medium' || effort === 'high') {
            profile.params = { reasoningEffort: effort } as typeof profile.params;
          }
          items.push(
            previewItem(
              'modelProviders',
              `${cfg.path}:model`,
              'openai',
              'inferred provider "openai" from external model settings',
              { kind: 'modelProvider', provider: { id: 'openai', label: 'OpenAI', type: ModelProviderType.OpenAI } }
            )
          );
          items.push(
            previewItem(
              'modelProfiles',
              `${cfg.path}:model`,
              profile.alias,
              'external default model can be represented as a Monad model profile',
              { kind: 'modelProfile', profile, makeDefault: true }
            )
          );
        }
        if (cfg) addMcpItems(items, cfg.path, data, 'codex');
        if (cfg) {
          const sandbox = asString(data.sandbox_mode);
          if (sandbox) {
            const mode = sandbox === 'danger-full-access' ? 'unrestricted' : 'workspace';
            items.push(
              previewItem(
                'sandbox',
                `${cfg.path}:sandbox_mode`,
                'sandbox.mode',
                `Codex sandbox_mode can be mapped to Monad sandbox mode "${mode}"`,
                { kind: 'sandbox', mode },
                { risk: mode === 'unrestricted' ? 'high' : 'medium' }
              )
            );
          }
          const approval = asString(data.approval_policy);
          if (approval)
            items.push(
              previewItem(
                'approvals',
                `${cfg.path}:approval_policy`,
                'agent.approvals',
                'Codex approval policy is coarser than Monad operator allow/ask/deny lists',
                { kind: 'approval', approvalPolicy: approval },
                { action: 'manual', risk: 'high' }
              )
            );
          if (isRecord(data.plugins) || isRecord(data.apps))
            items.push(
              previewItem(
                'plugins',
                cfg.path,
                'plugins/apps',
                'Codex plugins/apps/connectors are not equivalent to Monad skills or MCP servers',
                { kind: 'manual' },
                { action: 'manual', risk: 'medium' }
              )
            );
        }
        if (isDir) await addSkillItems(items, 'codex:skills', join(root, 'skills'));
      }
      return mergePreview('codex', normalizedSources, items, warnings);
    }
  };
}

export function createClaudeCodeSettingsImport(): MeshAgentSettingsImport {
  return {
    recognizes: (path) =>
      recognizesConfig(
        path,
        ['settings.json', '.claude/settings.json'],
        (data, file) =>
          /\/(?:\.?claude)(?:\/|$)/i.test(file) ||
          isRecord(data.mcpServers) ||
          isRecord(data.env) ||
          isRecord(data.hooks) ||
          data.agentPushNotifEnabled !== undefined
      ),
    detect(probes) {
      return defaultCandidates(
        'claude-code',
        'Claude Code',
        [{ path: join(homedir(), '.claude'), scope: 'global' }],
        probes
      );
    },
    async preview({ path, sources }): Promise<MeshAgentSettingsImportPreview> {
      const warnings: string[] = [];
      const normalizedSources: AdapterMigrationSource[] = [];
      const items: MeshAgentSettingsImportItem[] = [];
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
        const agent: MeshAgentView = {
          name: target,
          provider: 'claude-code',
          productIcon: 'claude-code',
          command: 'claude',
          args: [],
          ...(env && Object.keys(env).length > 0 ? { env } : {}),
          ...(modelOptions ? { modelOptions } : {}),
          enabled: true,
          allowAutopilot: false,
          approvalOwnership: 'provider-owned'
        };
        items.push(
          agentItem(cfg?.path ?? root, target, agent, modelOptions ? `models=${modelOptions.join(',')}` : undefined)
        );
        if (cfg) addMcpItems(items, cfg.path, data, 'claude-code');
        if (cfg && isRecord(data.env)) {
          for (const [name, value] of Object.entries(data.env)) {
            if (typeof value !== 'string') continue;
            items.push(
              previewItem(
                'credentials',
                `${cfg.path}:env.${name}`,
                `env:${name}`,
                `secret-bearing env value can be referenced as \${env:${name}} but is not imported as a raw credential`,
                { kind: 'manual' },
                { action: 'manual', risk: 'high', summary: `\${env:${name}}` }
              )
            );
          }
        }
        if (isDir) await addClaudeAgents(items, root);
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

export function createFrameworkSettingsImport(provider: 'hermes' | 'openclaw', label: string): MeshAgentSettingsImport {
  return {
    recognizes: (path) =>
      recognizesConfig(path, frameworkConfigNames(provider), (data, file) =>
        provider === 'openclaw'
          ? /openclaw/i.test(file) || isRecord(data.mcp) || data.state !== undefined || data.database !== undefined
          : /hermes/i.test(file) || /\.ya?ml$/i.test(file) || isRecord(data.mcp_servers) || isRecord(data.model)
      ),
    detect(probes) {
      return defaultCandidates(provider, label, [{ path: join(homedir(), `.${provider}`), scope: 'global' }], probes);
    },
    async preview({ path, sources }): Promise<MeshAgentSettingsImportPreview> {
      const warnings: string[] = [];
      const normalizedSources: AdapterMigrationSource[] = [];
      const items: MeshAgentSettingsImportItem[] = [];
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
          if (data.workflow || data.workflows || data.state || data.database || data.runtime_plugins || data.plugins) {
            items.push(
              previewItem(
                'plugins',
                cfg.path,
                `${provider}:runtime`,
                `${provider} workflow/state/runtime plugin concepts are not Monad settings`,
                { kind: 'manual' },
                { action: 'manual', risk: 'medium' }
              )
            );
          }
        }
        const target = targetForScope(provider, source.scope);
        const agent: MeshAgentView = {
          name: target,
          provider,
          productIcon: provider,
          command: provider,
          args: [],
          enabled: true,
          allowAutopilot: false,
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
  provider: MeshAgentProvider,
  label: string,
  command: string,
  homeConfigDir: string,
  configNames = ['settings.json', 'config.json', 'config.yaml', 'config.yml']
): MeshAgentSettingsImport {
  return {
    detect(probes) {
      return defaultCandidates(provider, label, [{ path: join(homedir(), homeConfigDir), scope: 'global' }], probes);
    },
    async preview({ path, sources }): Promise<MeshAgentSettingsImportPreview> {
      const warnings: string[] = [];
      const normalizedSources: AdapterMigrationSource[] = [];
      const items: MeshAgentSettingsImportItem[] = [];
      for (const source of sourcesForRequest(path, sources)) {
        const { root, isDir } = await pathInfo(source.path);
        normalizedSources.push({ ...source, path: root });
        const cfg = await readConfigObject(root, isDir, configNames);
        const data = isRecord(cfg?.data) ? cfg.data : {};
        if (!cfg) warnings.push(`No ${label} settings/config file found at ${root}.`);
        else addMcpItems(items, cfg.path, data, provider);
        const target = targetForScope(provider, source.scope);
        const agent: MeshAgentView = {
          name: target,
          provider,
          productIcon: provider,
          command,
          args: [],
          enabled: true,
          allowAutopilot: false,
          approvalOwnership: 'provider-owned'
        };
        items.push(agentItem(cfg?.path ?? root, target, agent));
        if (isDir) await addSkillItems(items, `${provider}:skills`, join(root, 'skills'));
      }
      return mergePreview(provider, normalizedSources, items, warnings);
    }
  };
}

export function meshAgentSettingsImportPreviewItemChanged(
  item: MeshAgentSettingsImportItem,
  expectedHash: string | undefined
): boolean {
  return !expectedHash || meshAgentSettingsImportItemHash(publicItemWithoutHash(item)) !== expectedHash;
}
