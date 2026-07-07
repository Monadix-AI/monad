import type {
  AdapterMigrationSource,
  ExternalAgentProvider,
  ExternalAgentSettingsImportItem,
  ExternalAgentSettingsImportPreview,
  ExternalAgentView
} from '@monad/protocol';
import type { ExternalAgentSettingsImport } from '@monad/sdk-atom';

import { homedir } from 'node:os';
import { join } from 'node:path';

import { externalAgentSettingsImportItemHash, publicItemWithoutHash } from './settings-import-hash.ts';
import {
  addChannelItems,
  addModelItems,
  addMonadAgentItem,
  addSkillItems,
  agentItem,
  defaultCandidates,
  mergePreview,
  sourcesForRequest,
  targetForScope
} from './settings-import-items.ts';
import { addMcpItems } from './settings-import-mcp.ts';
import { asString, asStringArray, isRecord, pathInfo, readConfigObject } from './settings-import-parse.ts';

export { externalAgentSettingsImportItemHash };

export function createCodexSettingsImport(): ExternalAgentSettingsImport {
  return {
    detect(probes) {
      return defaultCandidates('codex', 'Codex', [{ path: join(homedir(), '.codex'), scope: 'global' }], probes);
    },
    async preview({ path, sources }): Promise<ExternalAgentSettingsImportPreview> {
      const warnings: string[] = [];
      const normalizedSources: AdapterMigrationSource[] = [];
      const items: ExternalAgentSettingsImportItem[] = [];
      for (const source of sourcesForRequest(path, sources)) {
        const { root, isDir } = await pathInfo(source.path);
        const normalizedSource = { ...source, path: root };
        normalizedSources.push(normalizedSource);
        const cfg = await readConfigObject(root, isDir, ['config.toml', 'browser/config.toml']);
        const data = isRecord(cfg?.data) ? cfg.data : {};
        if (!cfg) warnings.push(`No Codex config.toml found at ${root}.`);
        const model = asString(data.model);
        const target = targetForScope('codex', source.scope);
        const agent: ExternalAgentView = {
          name: target,
          provider: 'codex',
          productIcon: 'codex',
          command: 'codex',
          args: [],
          ...(model ? { modelOptions: [model] } : {}),
          enabled: true,
          defaultLaunchMode: 'pty',
          allowAutopilot: false,
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

export function createClaudeCodeSettingsImport(): ExternalAgentSettingsImport {
  return {
    detect(probes) {
      return defaultCandidates(
        'claude-code',
        'Claude Code',
        [{ path: join(homedir(), '.claude'), scope: 'global' }],
        probes
      );
    },
    async preview({ path, sources }): Promise<ExternalAgentSettingsImportPreview> {
      const warnings: string[] = [];
      const normalizedSources: AdapterMigrationSource[] = [];
      const items: ExternalAgentSettingsImportItem[] = [];
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
        const agent: ExternalAgentView = {
          name: target,
          provider: 'claude-code',
          productIcon: 'claude-code',
          command: 'claude',
          args: [],
          ...(env && Object.keys(env).length > 0 ? { env } : {}),
          ...(modelOptions ? { modelOptions } : {}),
          enabled: true,
          defaultLaunchMode: 'pty',
          allowAutopilot: false,
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

export function createFrameworkSettingsImport(
  provider: 'hermes' | 'openclaw',
  label: string
): ExternalAgentSettingsImport {
  return {
    detect(probes) {
      return defaultCandidates(provider, label, [{ path: join(homedir(), `.${provider}`), scope: 'global' }], probes);
    },
    async preview({ path, sources }): Promise<ExternalAgentSettingsImportPreview> {
      const warnings: string[] = [];
      const normalizedSources: AdapterMigrationSource[] = [];
      const items: ExternalAgentSettingsImportItem[] = [];
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
        const agent: ExternalAgentView = {
          name: target,
          provider,
          productIcon: provider,
          command: provider,
          args: [],
          enabled: true,
          defaultLaunchMode: 'pty',
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
  provider: ExternalAgentProvider,
  label: string,
  command: string,
  homeConfigDir: string,
  configNames = ['settings.json', 'config.json', 'config.yaml', 'config.yml']
): ExternalAgentSettingsImport {
  return {
    detect(probes) {
      return defaultCandidates(provider, label, [{ path: join(homedir(), homeConfigDir), scope: 'global' }], probes);
    },
    async preview({ path, sources }): Promise<ExternalAgentSettingsImportPreview> {
      const warnings: string[] = [];
      const normalizedSources: AdapterMigrationSource[] = [];
      const items: ExternalAgentSettingsImportItem[] = [];
      for (const source of sourcesForRequest(path, sources)) {
        const { root, isDir } = await pathInfo(source.path);
        normalizedSources.push({ ...source, path: root });
        const cfg = await readConfigObject(root, isDir, configNames);
        const data = isRecord(cfg?.data) ? cfg.data : {};
        if (!cfg) warnings.push(`No ${label} settings/config file found at ${root}.`);
        else addMcpItems(items, cfg.path, data, provider);
        const target = targetForScope(provider, source.scope);
        const agent: ExternalAgentView = {
          name: target,
          provider,
          productIcon: provider,
          command,
          args: [],
          enabled: true,
          defaultLaunchMode: 'pty',
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

export function externalAgentSettingsImportPreviewItemChanged(
  item: ExternalAgentSettingsImportItem,
  expectedHash: string | undefined
): boolean {
  return !expectedHash || externalAgentSettingsImportItemHash(publicItemWithoutHash(item)) !== expectedHash;
}
