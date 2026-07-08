import type { Snapshot } from './types.ts';

import { join } from 'node:path';

import { midnightIso } from './dates.ts';

export function parseNulSeparatedPaths(bytes: Uint8Array): string[] {
  return new TextDecoder().decode(bytes).split('\0').filter(Boolean);
}

export function countLinesInBytes(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  let lines = 0;
  for (const byte of bytes) {
    if (byte === 10) lines += 1;
  }
  return lines;
}

export async function collectSnapshots(root: string, dates: string[]): Promise<Map<string, Snapshot>> {
  const snapshots = new Map<string, Snapshot>();
  const countCache = new Map<string, Omit<Snapshot, 'commit'>>();
  for (const date of dates) {
    const commit = await commitBeforeMidnight(root, date);
    if (!commit) continue;
    let counted = countCache.get(commit);
    if (!counted) {
      counted = await countCommitLoc(root, commit);
      countCache.set(commit, counted);
    }
    snapshots.set(date, { commit: commit.slice(0, 9), ...counted });
  }
  return snapshots;
}

export async function countWorkingTreeLoc(cwd: string): Promise<Omit<Snapshot, 'commit'>> {
  const output = await Bun.$`git ls-files -z --cached --others --exclude-standard`.cwd(cwd).arrayBuffer();
  const paths = sourcePaths(parseNulSeparatedPaths(new Uint8Array(output)));
  const counts = await Promise.all(
    paths.map(async (path) => {
      const bytes = new Uint8Array(await Bun.file(join(cwd, path)).arrayBuffer());
      const lines = countLinesInBytes(bytes);
      return lines;
    })
  );
  return sumCounts(counts);
}

async function commitBeforeMidnight(root: string, date: string): Promise<string | null> {
  const commit = await Bun.$`git rev-list -1 --all --before=${midnightIso(date)}`
    .cwd(root)
    .text()
    .then((text) => text.trim())
    .catch(() => '');
  return commit || null;
}

async function countCommitLoc(root: string, commit: string): Promise<Omit<Snapshot, 'commit'>> {
  const output = await Bun.$`git ls-tree -rz --name-only ${commit}`.cwd(root).arrayBuffer();
  const paths = sourcePaths(parseNulSeparatedPaths(new Uint8Array(output)));
  const counts = (await readCommitBlobs(root, commit, paths)).map(countLinesInBytes);
  return sumCounts(counts);
}

function sourcePaths(paths: string[]): string[] {
  return paths.filter((path) => path.endsWith('.ts') || path.endsWith('.tsx'));
}

async function readCommitBlobs(root: string, commit: string, paths: string[]): Promise<Uint8Array[]> {
  if (paths.length === 0) return [];
  const proc = Bun.spawn(['git', 'cat-file', '--batch'], {
    cwd: root,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe'
  });
  proc.stdin.write(paths.map((path) => `${commit}:${path}\n`).join(''));
  proc.stdin.end();
  const bytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  await proc.exited;
  const blobs: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const headerEnd = bytes.indexOf(10, offset);
    if (headerEnd === -1) break;
    const header = new TextDecoder().decode(bytes.slice(offset, headerEnd));
    offset = headerEnd + 1;
    const [, type, rawSize] = header.match(/^[0-9a-f]+ (\S+) (\d+)$/) ?? [];
    if (!type || !rawSize) break;
    const size = Number(rawSize);
    const body = bytes.slice(offset, offset + size);
    offset += size + 1;
    if (type === 'blob') blobs.push(body);
  }
  return blobs;
}

function sumCounts(counts: number[]): Omit<Snapshot, 'commit'> {
  return counts.reduce(
    (total, count) => {
      total.files += 1;
      total.lines += count;
      return total;
    },
    { files: 0, lines: 0 }
  );
}
