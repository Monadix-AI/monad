import type { KnownSource } from '../types.ts';

function genericPathSource(inputPath: string): KnownSource | undefined {
  const segments = inputPath.replace(/\\/g, '/').split('/').filter(Boolean);
  const hasSegment = (pattern: RegExp) => segments.some((segment) => pattern.test(segment));
  const hasAdjacent = (first: RegExp, second: RegExp) =>
    segments.some((segment, index) => {
      const next = segments[index + 1];
      return first.test(segment) && next !== undefined && second.test(next);
    });
  if (hasSegment(/^\.?claude[-_ ]?desktop$/i) || hasSegment(/^claude_desktop_config\.json$/i)) {
    return 'claude-desktop';
  }
  if (hasSegment(/^\.?cursor$/i)) return 'cursor';
  if (hasSegment(/^\.?vscode$/i) || hasAdjacent(/^code$/i, /^user$/i)) return 'vscode';
  if (hasSegment(/^\.?aider$/i)) return 'aider';
  if (hasSegment(/^\.?continue$/i)) return 'continue';
  if (hasSegment(/^\.?(roo|roo-code|cline)$/i)) return 'roo-code';
  return undefined;
}

export async function detectSource(inputPath: string): Promise<KnownSource> {
  const source = genericPathSource(inputPath);
  if (source) return source;
  throw new Error(`no registered agent adapter or generic settings source recognized "${inputPath}"`);
}
