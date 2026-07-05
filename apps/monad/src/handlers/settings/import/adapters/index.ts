import type { ImportSettingsRequest } from '@monad/protocol';
import type { ParsedImport } from '../types.ts';

import { parseClaudeCode } from './claude-code.ts';
import { parseCodex } from './codex.ts';
import { detectSource } from './detect.ts';
import { parseFramework } from './framework.ts';
import { parseGenericMcpConfig } from './generic.ts';

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
