import type { ParsedImport, PlannedItem } from '../types.ts';

import { join } from 'node:path';

import { mcpFromRecord } from './mcp.ts';
import { addModelProfileFromExternal } from './providers.ts';
import { addItem, asString, isRecord, pathInfo, readFirstConfigObject, recordAt } from './shared.ts';
import { addSkillItems } from './skill-items.ts';

export async function parseCodex(inputPath: string): Promise<ParsedImport> {
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
        reason: server ? `Codex MCP server maps to Monad mcpServers${timeoutNote}` : 'Unsupported Codex MCP shape',
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
        target: 'sandbox.mode',
        action: 'add',
        reason: `Codex sandbox_mode can be mapped to Monad sandbox mode "${mode}"`,
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
        reason: 'Codex approval policy is coarser than Monad operator allow/ask/deny lists',
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
        reason: 'Codex plugins/apps/connectors are not equivalent to Monad skills or MCP servers',
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
