import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface MeshAgentEventFileSearch {
  roots: string[];
  providerSessionRef: string;
  extensions: string[];
  maxDepth?: number;
}

interface EventFileCandidate {
  path: string;
  mtimeMs: number;
}

function findLatestEventFile(args: MeshAgentEventFileSearch): string | null {
  let best: EventFileCandidate | null = null;
  const nameFragments = [args.providerSessionRef, args.providerSessionRef.split('-')[0]].filter(
    (fragment): fragment is string => !!fragment
  );
  const stack = args.roots.filter((root) => existsSync(root)).map((root) => ({ path: root, depth: 0 }));
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of readdirSync(current.path, { withFileTypes: true })) {
      const path = join(current.path, entry.name);
      if (entry.isDirectory()) {
        if (args.maxDepth === undefined || current.depth < args.maxDepth)
          stack.push({ path, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (!args.extensions.some((extension) => entry.name.endsWith(extension))) continue;
      if (!nameFragments.some((fragment) => entry.name.includes(fragment))) continue;
      const mtimeMs = statSync(path).mtimeMs;
      if (!best || mtimeMs > best.mtimeMs) best = { path, mtimeMs };
    }
  }
  return best?.path ?? null;
}

export function readProviderEventFile(args: MeshAgentEventFileSearch): string | null {
  const file = findLatestEventFile(args);
  return file ? readFileSync(file, 'utf8') : null;
}
