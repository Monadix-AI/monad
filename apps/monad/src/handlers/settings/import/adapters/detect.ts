import type { KnownSource } from '../types.ts';

import { basename, extname } from 'node:path';

import { isRecord, pathInfo, readFirstConfigObject, recordAt } from './shared.ts';

export async function detectSource(inputPath: string): Promise<KnownSource> {
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
