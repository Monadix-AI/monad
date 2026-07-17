import type { KnownSource } from '../types.ts';

import { basename, extname } from 'node:path';

import { isRecord, pathInfo, readFirstConfigObject, recordAt } from './shared.ts';

// Product markers are whole path segments (~/.cursor, Claude Desktop, Code/User), matched exactly
// per segment. Substring matching over the absolute path misdetects whenever the checkout or home
// prefix merely contains a product name (a worktree named "…-cursor-fix", ~/claude-workspace/…),
// while exact segments still detect markers at any depth (~/.cursor/projects/foo/mcp.json).
function pathSource(inputPath: string, includeBareClaude: boolean): KnownSource | undefined {
  const segments = inputPath.replace(/\\/g, '/').split('/').filter(Boolean);
  const hasSegment = (re: RegExp) => segments.some((segment) => re.test(segment));
  const hasAdjacent = (first: RegExp, second: RegExp) =>
    segments.some((segment, index) => {
      const next = segments[index + 1];
      return first.test(segment) && next !== undefined && second.test(next);
    });
  if (hasSegment(/^\.?claude[-_ ]?desktop$/i) || hasSegment(/^claude_desktop_config\.json$/i)) return 'claude-desktop';
  if (hasSegment(/^\.?(open-?claw|opencalw)$/i)) return 'openclaw';
  if (hasSegment(/^\.?hermes$/i)) return 'hermes';
  if (hasSegment(/^\.?cursor$/i)) return 'cursor';
  if (hasSegment(/^\.?vscode$/i) || hasAdjacent(/^code$/i, /^user$/i)) return 'vscode';
  if (hasSegment(/^\.?aider$/i)) return 'aider';
  if (hasSegment(/^\.?continue$/i)) return 'continue';
  if (hasSegment(/^\.?(roo|roo-code|cline)$/i)) return 'roo-code';
  if (includeBareClaude && hasSegment(/^\.?claude$/i)) return 'claude-code';
  return undefined;
}

export async function detectSource(inputPath: string): Promise<KnownSource> {
  const { root, isDir } = await pathInfo(inputPath);
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
    const fromPath = pathSource(inputPath, false);
    if (fromPath) return fromPath;
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
  return pathSource(inputPath, true) ?? 'codex';
}
