import type { ParsedImport, PlannedItem } from '../types.ts';

import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { envValue, mcpFromRecord } from './mcp.ts';
import { addItem, asString, isRecord, pathInfo, readFirstConfigObject, recordAt } from './shared.ts';

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
        reason: 'Claude Code subagent persona maps to a Monad agent; Claude tools are not imported',
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

export async function parseClaudeCode(inputPath: string): Promise<ParsedImport> {
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
        reason: server ? 'Claude Code MCP server maps to Monad mcpServers' : 'Unsupported Claude Code MCP shape',
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
