// Filesystem tools — read / glob / grep / write / patch. Tool arguments are
// attacker-controllable, so every path passes through the sandbox backend and
// out-of-sandbox path gate before the resource is touched.

import type { FsBackend, Tool, ToolContext, ToolDisplayContent } from '../types.ts';
import type { ToolModule } from './contract.ts';

import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';

import { createSandboxBackends, resolveReal } from '../backends.ts';
import { gatePathAccess } from '../path-gate.ts';
import { ToolSecurityError } from '../security.ts';
import { toolResult } from '../types.ts';

const DEFAULT_READ_LINES = 2000;
const MAX_GLOB_RESULTS = 1000;
const MAX_GREP_MATCHES = 1000;
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024;
const NUL_CHAR = String.fromCharCode(0);
const ALWAYS_IGNORE = ['node_modules', '.git'];
const DISPLAY_TEXT_LIMIT = 8_000;
const MAX_DIFF_LINES = 200;
const MAX_DIFF_CELLS = 40_000;

export interface FileMutationResult {
  path: string;
  operation: 'add' | 'update' | 'delete' | 'move' | 'write';
  bytesWritten?: number;
  beforeHash: string | null;
  afterHash: string | null;
  changed: boolean;
  diff: string | null;
  diffFormat: 'unified';
  summary: {
    added: number;
    removed: number;
    changed: boolean;
  };
  display: Extract<ToolDisplayContent, { type: 'diff' }>;
  newPath?: string;
}

export interface FilePatchResult {
  files: FileMutationResult[];
  touchedFiles: string[];
  changed: boolean;
  summary: {
    added: number;
    removed: number;
    changed: boolean;
  };
}

type ReadLedgerEntry = {
  hash: string;
  mtimeMs: number | null;
  readAt: number;
};

const readLedger = new Map<string, Map<string, ReadLedgerEntry>>();

function fsBackend(ctx: ToolContext) {
  return ctx.backends?.fs ?? createSandboxBackends(ctx.sandboxRoots, { defaultCwd: ctx.defaultCwd }).fs;
}

const toPosix = (p: string): string => p.replaceAll('\\', '/');

function sha256(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex');
}

function canonicalize(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function ledgerPath(path: string): string {
  return toPosix(canonicalize(path));
}

function fileMtimeMs(path: string): number | null {
  try {
    const mtime = Bun.file(canonicalize(path)).lastModified;
    return Number.isFinite(mtime) && mtime > 0 ? mtime : null;
  } catch {
    return null;
  }
}

function rememberRead(ctx: ToolContext, path: string, text: string): void {
  let session = readLedger.get(ctx.sessionId);
  if (!session) {
    session = new Map();
    readLedger.set(ctx.sessionId, session);
  }
  session.set(ledgerPath(path), { hash: sha256(text), mtimeMs: fileMtimeMs(path), readAt: Date.now() });
}

function readEntry(ctx: ToolContext, path: string): ReadLedgerEntry | undefined {
  return readLedger.get(ctx.sessionId)?.get(ledgerPath(path));
}

function displayPath(path: string, ctx: ToolContext): string {
  const canonicalPath = canonicalize(path);
  const canonicalPathPosix = toPosix(canonicalPath);
  const root = ctx.sandboxRoots?.find((r) => {
    const canonicalRootPosix = toPosix(canonicalize(r));
    return canonicalPathPosix === canonicalRootPosix || canonicalPathPosix.startsWith(`${canonicalRootPosix}/`);
  });
  return root ? toPosix(relative(canonicalize(root), canonicalPath)) : canonicalPathPosix;
}

function splitDiffLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (normalized === '') return [];
  const lines = normalized.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function diffLinesFromLines(a: string[], b: string[]): { lines: string[]; added: number; removed: number } {
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  const score = (row: number, col: number): number => lcs[row]?.[col] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    const row = lcs[i];
    if (!row) continue;
    for (let j = b.length - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? score(i + 1, j + 1) + 1 : Math.max(score(i + 1, j), score(i, j + 1));
    }
  }

  const lines: string[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push(` ${a[i]}`);
      i++;
      j++;
    } else if (j < b.length && (i === a.length || score(i, j + 1) > score(i + 1, j))) {
      lines.push(`+${b[j]}`);
      added++;
      j++;
    } else {
      lines.push(`-${a[i]}`);
      removed++;
      i++;
    }
  }
  return { lines, added, removed };
}

function shouldSkipDiff(beforeLines: string[], afterLines: string[]): boolean {
  return (
    beforeLines.length > MAX_DIFF_LINES ||
    afterLines.length > MAX_DIFF_LINES ||
    (beforeLines.length + 1) * (afterLines.length + 1) > MAX_DIFF_CELLS
  );
}

function createUnifiedDiff(
  path: string,
  beforeLines: string[],
  afterLines: string[],
  lines: string[]
): FileMutationResult['diff'] {
  return [
    `--- ${path}\tBefore`,
    `+++ ${path}\tAfter`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ...lines,
    ''
  ].join('\n');
}

function createDiffSummary(
  path: string,
  before: string | null,
  after: string | null
): {
  added: number;
  removed: number;
  diff: FileMutationResult['diff'];
  diffSkipped: boolean;
} {
  const oldText = before ?? '';
  const newText = after ?? '';
  const beforeLines = splitDiffLines(oldText);
  const afterLines = splitDiffLines(newText);
  if (oldText === newText) return { added: 0, removed: 0, diff: null, diffSkipped: false };
  if (shouldSkipDiff(beforeLines, afterLines)) {
    return { added: afterLines.length, removed: beforeLines.length, diff: null, diffSkipped: true };
  }
  const result = diffLinesFromLines(beforeLines, afterLines);
  return {
    added: result.added,
    removed: result.removed,
    diff: createUnifiedDiff(path, beforeLines, afterLines, result.lines),
    diffSkipped: false
  };
}

function displayPreview(text: string): { text: string; truncated: boolean } {
  if (text.length <= DISPLAY_TEXT_LIMIT) return { text, truncated: false };
  return {
    text: `${text.slice(0, DISPLAY_TEXT_LIMIT)}\n[truncated ${text.length - DISPLAY_TEXT_LIMIT} chars]`,
    truncated: true
  };
}

function createMutationResult(
  ctx: ToolContext,
  path: string,
  before: string | null,
  after: string | null,
  operation: FileMutationResult['operation'],
  extra: Pick<FileMutationResult, 'bytesWritten' | 'newPath'> = {}
): FileMutationResult {
  const shownPath = displayPath(path, ctx);
  const changed = before !== after;
  const { added, removed, diff, diffSkipped } = createDiffSummary(shownPath, before, after);
  const beforePreview = before === null ? null : displayPreview(before);
  const afterPreview = after === null ? null : displayPreview(after);
  const diffPreview = diff === null ? null : displayPreview(diff);
  const display = {
    type: 'diff' as const,
    path,
    beforeText: beforePreview?.text ?? null,
    afterText: afterPreview?.text ?? '',
    ...(diffPreview ? { diff: diffPreview.text } : {}),
    diffStat: { added, removed },
    ...(beforePreview?.truncated || afterPreview?.truncated || diffPreview?.truncated || diffSkipped
      ? { truncated: true }
      : {})
  };
  return {
    path,
    operation,
    ...extra,
    beforeHash: before === null ? null : sha256(before),
    afterHash: after === null ? null : sha256(after),
    changed,
    diff,
    diffFormat: 'unified',
    summary: { added, removed, changed },
    display
  };
}

function mutationSummary(output: FileMutationResult): string {
  const target = output.newPath ? `${output.path} -> ${output.newPath}` : output.path;
  const delta = `${output.summary.added} added, ${output.summary.removed} removed`;
  return `${output.operation} ${target}. ${output.changed ? delta : 'No content changes'}. beforeHash=${output.beforeHash ?? 'new'} afterHash=${output.afterHash ?? 'deleted'}`;
}

function patchSummary(output: FilePatchResult): string {
  const delta = `${output.summary.added} added, ${output.summary.removed} removed`;
  return `Patched ${output.files.length} file${output.files.length === 1 ? '' : 's'} (${delta}).`;
}

async function readExistingText(fs: FsBackend, path: string): Promise<string | null> {
  try {
    return await fs.readTextFile(path);
  } catch {
    return null;
  }
}

function ignored(path: string): boolean {
  const p = toPosix(path);
  return ALWAYS_IGNORE.some((seg) => p === seg || p.includes(`${seg}/`) || p.includes(`/${seg}/`));
}

async function withFsGate<T>(path: string, ctx: ToolContext, fn: (fs: FsBackend) => Promise<T>): Promise<T> {
  try {
    return await fn(fsBackend(ctx));
  } catch (err) {
    const expanded = await gatePathAccess(path, ctx, err);
    return fn(createSandboxBackends(expanded, { defaultCwd: ctx.defaultCwd }).fs);
  }
}

function assertFreshRead(ctx: ToolContext, path: string, currentText: string): void {
  const entry = readEntry(ctx, path);
  if (!entry) {
    throw new ToolSecurityError('File has not been read yet. Read it first before writing to it.');
  }
  const currentMtimeMs = fileMtimeMs(path);
  const mtimeChanged = entry.mtimeMs !== null && currentMtimeMs !== null && entry.mtimeMs !== currentMtimeMs;
  if (entry.hash !== sha256(currentText) || mtimeChanged) {
    throw new ToolSecurityError('File has been modified since read. Read it again before writing to it.');
  }
}

const fileReadInput = z.object({
  path: z.string().min(1),
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).optional()
});

export const fileReadTool: Tool<z.infer<typeof fileReadInput>, string> = {
  name: 'file_read',
  description:
    'Read a UTF-8 text file. Returns lines with 1-based line numbers (format: "N\\tcontent"). Defaults to first 2000 lines; use offset to page through large files.',
  scopes: [{ resource: 'fs:read' }],
  inputSchema: fileReadInput,
  run: async ({ path, offset, limit }, ctx) =>
    withFsGate(path, ctx, async (fs) => {
      const fullText = await fs.readTextFile(path);
      rememberRead(ctx, path, fullText);
      const effectiveLimit = limit ?? DEFAULT_READ_LINES;
      const startLine = offset ?? 1;
      const lines = fullText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
      while (lines.length > 0 && lines.at(-1) === '') lines.pop();
      const selected = lines.slice(startLine - 1, startLine - 1 + effectiveLimit);
      const numbered = selected.map((line, i) => `${startLine + i}\t${line}`).join('\n');
      if (limit === undefined && selected.length === effectiveLimit && startLine - 1 + selected.length < lines.length) {
        return toolResult(`${numbered}\n(truncated; use offset=${startLine + selected.length} to continue)`);
      }
      return toolResult(numbered);
    })
};

const fileWriteInput = z.object({
  path: z.string().min(1),
  content: z.string(),
  baseHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional()
});

export const fileWriteTool: Tool<z.infer<typeof fileWriteInput>, FileMutationResult> = {
  name: 'file_write',
  description:
    'Create or overwrite a UTF-8 text file. Existing files must be read first, or baseHash must match the current file hash.',
  scopes: [{ resource: 'fs:write' }],
  needsApproval: (_input, ctx) => !ctx.backends?.fs.delegated && ctx.sandboxRoots === undefined,
  inputSchema: fileWriteInput,
  run: ({ path, content, baseHash }, ctx) =>
    withFsGate(path, ctx, async (fs) => {
      const before = await readExistingText(fs, path);
      if (before !== null) {
        const currentHash = sha256(before);
        if (baseHash !== undefined) {
          if (baseHash !== currentHash) {
            throw new ToolSecurityError('baseHash does not match the current file. Read it again before writing.');
          }
        } else {
          assertFreshRead(ctx, path, before);
        }
      }
      const { path: written, bytesWritten } = await fs.writeTextFile(path, content);
      const result = createMutationResult(ctx, written, before, content, 'write', { bytesWritten });
      rememberRead(ctx, written, content);
      return toolResult(result, { modelContent: mutationSummary(result), displayContent: result.display });
    })
};

const fileGlobInput = z.object({
  pattern: z.string().min(1),
  path: z.string().optional()
});

export const fileGlobTool: Tool<z.infer<typeof fileGlobInput>, string[]> = {
  name: 'file_glob',
  description:
    'List files matching a glob pattern (e.g. "src/**/*.ts"), relative to the scan directory. Skips node_modules/.git.',
  scopes: [{ resource: 'fs:read' }],
  inputExamples: [{ pattern: '**/*.ts' }, { pattern: '**/*.test.ts', path: 'packages' }],
  inputSchema: fileGlobInput,
  run: async ({ pattern, path }, ctx) => {
    const scanPath = path ?? ctx.sandboxRoots?.[0] ?? process.cwd();
    let cwd: string;
    try {
      cwd = await resolveReal(scanPath, ctx.sandboxRoots);
    } catch (err) {
      if (!path) throw err;
      const dir = isAbsolute(path) ? resolve(path) : resolve(ctx.sandboxRoots?.[0] ?? process.cwd(), path);
      const expanded = await gatePathAccess(path, ctx, err, dir);
      cwd = await resolveReal(path, expanded);
    }
    const glob = new Bun.Glob(pattern);
    const out: string[] = [];
    for await (const match of glob.scan({ cwd, onlyFiles: true, dot: false })) {
      if (ignored(match)) continue;
      out.push(toPosix(match));
      if (out.length >= MAX_GLOB_RESULTS) break;
    }
    return toolResult(out.sort());
  }
};

const fileGrepInput = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  glob: z.string().optional(),
  flags: z.string().optional()
});

export interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

export const fileGrepTool: Tool<z.infer<typeof fileGrepInput>, GrepMatch[]> = {
  name: 'file_grep',
  description:
    'Search file contents by regex and return matching lines with file + line number. Skips node_modules/.git and large/binary files.',
  scopes: [{ resource: 'fs:read' }],
  inputSchema: fileGrepInput,
  run: async ({ pattern, path, glob, flags }, ctx) => {
    let re: RegExp;
    try {
      re = new RegExp(pattern, flags ?? '');
    } catch (err) {
      throw new ToolSecurityError(`invalid regex: ${(err as Error).message}`);
    }
    const scanPath = path ?? ctx.sandboxRoots?.[0] ?? process.cwd();
    let cwd: string;
    try {
      cwd = await resolveReal(scanPath, ctx.sandboxRoots);
    } catch (err) {
      if (!path) throw err;
      const dir = isAbsolute(path) ? resolve(path) : resolve(ctx.sandboxRoots?.[0] ?? process.cwd(), path);
      const expanded = await gatePathAccess(path, ctx, err, dir);
      cwd = await resolveReal(path, expanded);
    }
    const scanner = new Bun.Glob(glob ?? '**/*');
    const matches: GrepMatch[] = [];
    outer: for await (const rel of scanner.scan({ cwd, onlyFiles: true, dot: false })) {
      if (ignored(rel)) continue;
      const file = Bun.file(join(cwd, rel));
      if (file.size > MAX_GREP_FILE_BYTES) continue;
      let text: string;
      try {
        text = await file.text();
      } catch {
        continue;
      }
      if (text.includes(NUL_CHAR)) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const lineText = (lines[i] ?? '').replace(/\r$/, '');
        re.lastIndex = 0;
        if (re.test(lineText)) {
          matches.push({ file: toPosix(rel), line: i + 1, text: lineText.slice(0, 500) });
          if (matches.length >= MAX_GREP_MATCHES) break outer;
        }
      }
    }
    return toolResult(matches);
  }
};

type PatchOp =
  | { type: 'add'; path: string; lines: string[] }
  | { type: 'delete'; path: string }
  | { type: 'update'; path: string; newPath?: string; hunks: PatchHunk[] };

interface PatchHunk {
  oldLines: string[];
  newLines: string[];
}

function isFileHeader(line: string): boolean {
  return (
    line.startsWith('*** Add File: ') ||
    line.startsWith('*** Delete File: ') ||
    line.startsWith('*** Update File: ') ||
    line === '*** End Patch'
  );
}

function parsePatch(patch: string): PatchOp[] {
  const lines = patch.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines[0] !== '*** Begin Patch') throw new ToolSecurityError('patch must start with "*** Begin Patch"');
  if (lines.at(-1) !== '*** End Patch') throw new ToolSecurityError('patch must end with "*** End Patch"');
  const ops: PatchOp[] = [];
  let i = 1;
  while (i < lines.length - 1) {
    const line = lines[i] ?? '';
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i++;
      const content: string[] = [];
      while (i < lines.length - 1 && !isFileHeader(lines[i] ?? '')) {
        const l = lines[i] ?? '';
        if (!l.startsWith('+')) throw new ToolSecurityError(`add file lines must start with "+": ${l}`);
        content.push(l.slice(1));
        i++;
      }
      ops.push({ type: 'add', path, lines: content });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      ops.push({ type: 'delete', path: line.slice('*** Delete File: '.length).trim() });
      i++;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      i++;
      let newPath: string | undefined;
      if ((lines[i] ?? '').startsWith('*** Move to: ')) {
        newPath = (lines[i] ?? '').slice('*** Move to: '.length).trim();
        i++;
      }
      const hunks: PatchHunk[] = [];
      while (i < lines.length - 1 && !isFileHeader(lines[i] ?? '')) {
        const header = lines[i] ?? '';
        if (!header.startsWith('@@')) throw new ToolSecurityError(`expected hunk header, got: ${header}`);
        i++;
        const oldLines: string[] = [];
        const newLines: string[] = [];
        while (i < lines.length - 1 && !isFileHeader(lines[i] ?? '') && !(lines[i] ?? '').startsWith('@@')) {
          const hunkLine = lines[i] ?? '';
          if (hunkLine === '*** End of File') {
            i++;
            continue;
          }
          const marker = hunkLine[0];
          const text = hunkLine.slice(1);
          if (marker === ' ') {
            oldLines.push(text);
            newLines.push(text);
          } else if (marker === '-') {
            oldLines.push(text);
          } else if (marker === '+') {
            newLines.push(text);
          } else {
            throw new ToolSecurityError(`invalid hunk line: ${hunkLine}`);
          }
          i++;
        }
        hunks.push({ oldLines, newLines });
      }
      ops.push({ type: 'update', path, newPath, hunks });
      continue;
    }
    throw new ToolSecurityError(`unexpected patch line: ${line}`);
  }
  if (ops.length === 0) throw new ToolSecurityError('patch contains no file operations');
  return ops;
}

function findSubsequence(lines: string[], needle: string[], from: number): number {
  if (needle.length === 0) return from;
  for (let i = from; i <= lines.length - needle.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (lines[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

function applyHunks(text: string, hunks: PatchHunk[]): string {
  let lines = splitDiffLines(text);
  let searchFrom = 0;
  for (const hunk of hunks) {
    if (hunk.oldLines.length === 0) {
      lines.splice(searchFrom, 0, ...hunk.newLines);
      searchFrom += hunk.newLines.length;
      continue;
    }
    const at = findSubsequence(lines, hunk.oldLines, searchFrom);
    if (at === -1) throw new ToolSecurityError('patch context did not match the current file');
    lines = [...lines.slice(0, at), ...hunk.newLines, ...lines.slice(at + hunk.oldLines.length)];
    searchFrom = at + hunk.newLines.length;
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

function requireDelete(fs: FsBackend): NonNullable<FsBackend['deleteFile']> {
  if (!fs.deleteFile) throw new ToolSecurityError('file_patch delete is not supported by this filesystem backend');
  return fs.deleteFile.bind(fs);
}

function requireMove(fs: FsBackend): NonNullable<FsBackend['moveFile']> {
  if (!fs.moveFile) throw new ToolSecurityError('file_patch move is not supported by this filesystem backend');
  return fs.moveFile.bind(fs);
}

const filePatchInput = z.object({ patch: z.string().min(1) });

export const filePatchTool: Tool<z.infer<typeof filePatchInput>, FilePatchResult> = {
  name: 'file_patch',
  description:
    'Apply a structured patch to files. Supports Add File, Update File, Delete File, and Move to operations. Existing files must be read first.',
  scopes: [{ resource: 'fs:write' }],
  needsApproval: (_input, ctx) => !ctx.backends?.fs.delegated && ctx.sandboxRoots === undefined,
  inputSchema: filePatchInput,
  run: async ({ patch }, ctx) => {
    const ops = parsePatch(patch);
    const results: FileMutationResult[] = [];
    for (const op of ops) {
      if (op.type === 'add') {
        const content = op.lines.length === 0 ? '' : `${op.lines.join('\n')}\n`;
        const result = await withFsGate(op.path, ctx, async (fs) => {
          const existing = await readExistingText(fs, op.path);
          if (existing !== null) throw new ToolSecurityError(`cannot add existing file: ${op.path}`);
          const { path: written, bytesWritten } = await fs.writeTextFile(op.path, content);
          const mutation = createMutationResult(ctx, written, null, content, 'add', { bytesWritten });
          rememberRead(ctx, written, content);
          return mutation;
        });
        results.push(result);
        continue;
      }
      if (op.type === 'delete') {
        const result = await withFsGate(op.path, ctx, async (fs) => {
          const before = await fs.readTextFile(op.path);
          assertFreshRead(ctx, op.path, before);
          const deleted = await requireDelete(fs)(op.path);
          const mutation = createMutationResult(ctx, deleted.path, before, null, 'delete');
          return mutation;
        });
        results.push(result);
        continue;
      }
      const result = await withFsGate(op.path, ctx, async (fs) => {
        const before = await fs.readTextFile(op.path);
        assertFreshRead(ctx, op.path, before);
        const after = applyHunks(before, op.hunks);
        if (op.newPath) {
          const existingDest = await readExistingText(fs, op.newPath);
          if (existingDest !== null) throw new ToolSecurityError(`cannot move over existing file: ${op.newPath}`);
        }
        const { path: written, bytesWritten } = await fs.writeTextFile(op.path, after);
        let finalPath = written;
        if (op.newPath) {
          const moved = await requireMove(fs)(op.path, op.newPath);
          finalPath = moved.newPath;
        }
        const mutation = createMutationResult(ctx, written, before, after, op.newPath ? 'move' : 'update', {
          bytesWritten,
          ...(op.newPath ? { newPath: finalPath } : {})
        });
        rememberRead(ctx, finalPath, after);
        return mutation;
      });
      results.push(result);
    }
    const summary = results.reduce(
      (acc, file) => ({
        added: acc.added + file.summary.added,
        removed: acc.removed + file.summary.removed,
        changed: acc.changed || file.changed
      }),
      { added: 0, removed: 0, changed: false }
    );
    const output: FilePatchResult = {
      files: results,
      touchedFiles: results.flatMap((file) => (file.newPath ? [file.path, file.newPath] : [file.path])),
      changed: summary.changed,
      summary
    };
    return toolResult(output, {
      modelContent: patchSummary(output),
      displayContent: results.length === 1 ? results[0]?.display : undefined
    });
  }
};

const fileTools: Tool[] = [
  fileReadTool as Tool,
  fileWriteTool as Tool,
  fileGlobTool as Tool,
  fileGrepTool as Tool,
  filePatchTool as Tool
];

export const register: ToolModule = () => fileTools;
