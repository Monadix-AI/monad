import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface NativeCliHistoryFileSearch {
  roots: string[];
  providerSessionRef: string;
  extensions: string[];
  limitBytes: number;
  maxDepth?: number;
}

interface HistoryFileCandidate {
  path: string;
  mtimeMs: number;
}

function readTail(path: string, limitBytes: number): string {
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size;
    const length = Math.min(size, limitBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function findLatestHistoryFile(args: Omit<NativeCliHistoryFileSearch, 'limitBytes'>): string | null {
  let best: HistoryFileCandidate | null = null;
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

export function readProviderHistoryFile(args: NativeCliHistoryFileSearch): string | null {
  const file = findLatestHistoryFile(args);
  return file ? readTail(file, args.limitBytes) : null;
}
