// Filesystem tools — read / glob / grep / write / patch. Tool arguments are
// attacker-controllable, so every path passes through the sandbox backend and
// out-of-sandbox path gate before the resource is touched.

import type { FsBackend, Tool, ToolContext, ToolDisplayContent } from '../types.ts';
import type { ToolModule } from './contract.ts';

import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { ToolSecurityError } from '@monad/sandbox';
import { z } from 'zod';

import { gatePathAccess, type PathAccessOperation } from '../approval/path-gate.ts';
import { createSandboxBackends, resolveReal } from '../backends.ts';
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

interface FileMutationResult {
  status: 'ok';
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
  warning?: string;
}

interface FileMutationError {
  status: 'error';
  path: string;
  operation: 'add' | 'update' | 'delete' | 'move';
  error: string;
  newPath?: string;
}

type FilePatchFileResult = FileMutationResult | FileMutationError;

export interface FileMutationBatchResult {
  files: FilePatchFileResult[];
  touchedFiles: string[];
  succeeded: number;
  failed: number;
  changed: boolean;
  summary: {
    added: number;
    removed: number;
    changed: boolean;
  };
}

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

function baseHashMismatchMessage(label: string, path: string, expected: string, current: string): string {
  return `${label} does not match current file for ${ledgerPath(path)}. expected=${expected} current=${current}`;
}

async function rememberObservation(ctx: ToolContext, path: string, text: string): Promise<void> {
  await ctx.fileObservations?.remember(ctx.sessionId, {
    path: ledgerPath(path),
    hash: sha256(text),
    coverage: 'full',
    observedAt: new Date().toISOString(),
    ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {})
  });
}

async function readObservation(ctx: ToolContext, path: string) {
  return (await ctx.fileObservations?.get(ctx.sessionId, ledgerPath(path))) ?? null;
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
  extra: Pick<FileMutationResult, 'bytesWritten' | 'newPath' | 'warning'> = {}
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
    ...(extra.warning ? { warning: extra.warning } : {}),
    ...(beforePreview?.truncated || afterPreview?.truncated || diffPreview?.truncated || diffSkipped
      ? { truncated: true }
      : {})
  };
  return {
    status: 'ok',
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
  const warning = output.warning ? ` warning=${output.warning}` : '';
  return `${output.operation} ${target}. ${output.changed ? delta : 'No content changes'}. beforeHash=${output.beforeHash ?? 'new'} afterHash=${output.afterHash ?? 'deleted'}${warning}`;
}

function patchSummary(output: FileMutationBatchResult): string {
  const delta = `${output.summary.added} added, ${output.summary.removed} removed`;
  const failed = output.failed > 0 ? `, ${output.failed} failed` : '';
  const warningCount = output.files.filter((file) => file.status === 'ok' && file.warning).length;
  const warnings = warningCount > 0 ? `, ${warningCount} warning${warningCount === 1 ? '' : 's'}` : '';
  const warning =
    output.failed > 0 && output.succeeded > 0
      ? ' Some files were already modified; inspect per-file errors before retrying.'
      : '';
  return `Patched ${output.succeeded}/${output.files.length} file${output.files.length === 1 ? '' : 's'} (${delta}${failed}${warnings}).${warning}`;
}

function mutationError(op: PatchOp, err: unknown): FileMutationError {
  return {
    status: 'error',
    path: op.path,
    operation: op.type === 'update' && op.newPath ? 'move' : op.type,
    error: err instanceof Error ? err.message : String(err),
    ...(op.type === 'update' && op.newPath ? { newPath: op.newPath } : {})
  };
}

function fileMutationBatchResult(files: FilePatchFileResult[]): FileMutationBatchResult {
  const okFiles = files.filter((file): file is FileMutationResult => file.status === 'ok');
  const summary = okFiles.reduce(
    (acc, file) => ({
      added: acc.added + file.summary.added,
      removed: acc.removed + file.summary.removed,
      changed: acc.changed || file.changed
    }),
    { added: 0, removed: 0, changed: false }
  );
  return {
    files,
    touchedFiles: files.flatMap((file) => (file.newPath ? [file.path, file.newPath] : [file.path])),
    succeeded: okFiles.length,
    failed: files.length - okFiles.length,
    changed: summary.changed,
    summary
  };
}

function mutationDisplay(output: FileMutationBatchResult): ToolDisplayContent | undefined {
  if (output.files.length === 0) return undefined;
  if (output.files.length === 1 && output.files[0]?.status === 'ok') return output.files[0].display;
  const warnings = output.files.filter((file) => file.status === 'ok' && file.warning).length;
  return {
    type: 'multi_diff',
    summary: {
      added: output.summary.added,
      removed: output.summary.removed,
      succeeded: output.succeeded,
      failed: output.failed,
      total: output.files.length,
      ...(warnings > 0 ? { warnings } : {})
    },
    files: output.files.map((file) =>
      file.status === 'ok'
        ? {
            path: file.path,
            status: 'ok' as const,
            display: file.display,
            operation: file.operation,
            ...(file.newPath ? { newPath: file.newPath } : {})
          }
        : {
            path: file.path,
            status: 'error' as const,
            error: file.error,
            operation: file.operation,
            ...(file.newPath ? { newPath: file.newPath } : {})
          }
    )
  };
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

async function withFsGate<T>(
  path: string,
  ctx: ToolContext,
  options: { operation: PathAccessOperation; requestedByTool: string },
  fn: (fs: FsBackend) => Promise<T>
): Promise<T> {
  try {
    return await fn(fsBackend(ctx));
  } catch (err) {
    const expanded = await gatePathAccess(path, ctx, err, {
      operation: options.operation,
      pathKind: 'directory',
      requestedByTool: options.requestedByTool
    });
    return fn(createSandboxBackends(expanded, { defaultCwd: ctx.defaultCwd }).fs);
  }
}

async function assertFreshObservation(ctx: ToolContext, path: string, currentText: string): Promise<void> {
  const observation = await readObservation(ctx, path);
  if (!observation) {
    throw new ToolSecurityError('File has not been observed in this session. Read it first or provide baseHash.');
  }
  const currentHash = sha256(currentText);
  if (observation.hash !== currentHash) {
    throw new ToolSecurityError(
      `File has changed since the session observation for ${ledgerPath(path)}. observed=${observation.hash} current=${currentHash}. Read it again or provide baseHash.`
    );
  }
}

async function assertObservedOrBaseHash(
  ctx: ToolContext,
  path: string,
  text: string,
  options: PatchOptions,
  reason: string
): Promise<void> {
  const baseHash = providedBaseHash(path, options);
  if (baseHash !== undefined) {
    const currentHash = sha256(text);
    if (baseHash !== currentHash)
      throw new ToolSecurityError(baseHashMismatchMessage(`baseHashByPath["${path}"]`, path, baseHash, currentHash));
    return;
  }
  try {
    await assertFreshObservation(ctx, path, text);
  } catch (err) {
    if (err instanceof ToolSecurityError) {
      throw new ToolSecurityError(`${reason} requires a matching session observation or baseHashByPath["${path}"]`);
    }
    throw err;
  }
}

async function observationWarning(ctx: ToolContext, path: string, currentText: string): Promise<string | undefined> {
  const observation = await readObservation(ctx, path);
  if (!observation || observation.hash === sha256(currentText)) return undefined;
  return 'file changed since session observation; patch applied because hunk context matched current content';
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
    withFsGate(path, ctx, { operation: 'read', requestedByTool: 'file_read' }, async (fs) => {
      const fullText = await fs.readTextFile(path);
      const effectiveLimit = limit ?? DEFAULT_READ_LINES;
      const startLine = offset ?? 1;
      const lines = fullText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
      while (lines.length > 0 && lines.at(-1) === '') lines.pop();
      const selected = lines.slice(startLine - 1, startLine - 1 + effectiveLimit);
      const readComplete = startLine === 1 && startLine - 1 + selected.length >= lines.length;
      if (readComplete) await rememberObservation(ctx, path, fullText);
      const numbered = selected.map((line, i) => `${startLine + i}\t${line}`).join('\n');
      const partialNote = '(partial read; does not authorize whole-file overwrite)';
      if (limit === undefined && selected.length === effectiveLimit && startLine - 1 + selected.length < lines.length) {
        return toolResult(
          `${numbered}\n(truncated; use offset=${startLine + selected.length} to continue)\n${partialNote}`
        );
      }
      return toolResult(readComplete ? numbered : `${numbered}${numbered ? '\n' : ''}${partialNote}`);
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

export const fileWriteTool: Tool<z.infer<typeof fileWriteInput>, FileMutationBatchResult> = {
  name: 'file_write',
  description:
    'Create or overwrite a UTF-8 text file. Existing files must be read first, or baseHash must match the current file hash.',
  scopes: [{ resource: 'fs:write' }],
  needsApproval: (_input, ctx) => !ctx.backends?.fs.delegated && ctx.sandboxRoots === undefined,
  inputSchema: fileWriteInput,
  run: ({ path, content, baseHash }, ctx) =>
    withFsGate(path, ctx, { operation: 'write', requestedByTool: 'file_write' }, async (fs) => {
      const before = await readExistingText(fs, path);
      if (before !== null) {
        const currentHash = sha256(before);
        if (baseHash !== undefined) {
          if (baseHash !== currentHash) {
            throw new ToolSecurityError(baseHashMismatchMessage('baseHash', path, baseHash, currentHash));
          }
        } else {
          await assertFreshObservation(ctx, path, before);
        }
      }
      const { path: written, bytesWritten } = await fs.writeTextFile(path, content);
      const mutation = createMutationResult(ctx, written, before, content, 'write', { bytesWritten });
      const result = fileMutationBatchResult([mutation]);
      await rememberObservation(ctx, written, content);
      return toolResult(result, { modelContent: mutationSummary(mutation), displayContent: mutationDisplay(result) });
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
      const expanded = await gatePathAccess(path, ctx, err, {
        dir,
        operation: 'read',
        pathKind: 'directory',
        requestedByTool: 'file_glob'
      });
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
      const expanded = await gatePathAccess(path, ctx, err, {
        dir,
        operation: 'read',
        pathKind: 'directory',
        requestedByTool: 'file_grep'
      });
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

interface PatchGroup {
  ops: PatchOp[];
  paths: Set<string>;
}

interface PatchOptions {
  baseHashByPath?: Record<string, string>;
}

interface SimulatedFile {
  path: string;
  text: string | null;
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

function joinPatchLines(lines: string[], hadTrailingNewline: boolean): string {
  if (lines.length === 0) return '';
  const joined = lines.join('\n');
  return hadTrailingNewline ? `${joined}\n` : joined;
}

function applyHunks(path: string, text: string, hunks: PatchHunk[]): string {
  let lines = splitDiffLines(text);
  const hadTrailingNewline = text.endsWith('\n') || text.endsWith('\r');
  let searchFrom = 0;
  for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex++) {
    const hunk = hunks[hunkIndex] as PatchHunk;
    if (hunk.oldLines.length === 0) {
      lines.splice(searchFrom, 0, ...hunk.newLines);
      searchFrom += hunk.newLines.length;
      continue;
    }
    const at = findSubsequence(lines, hunk.oldLines, searchFrom);
    if (at === -1) {
      throw new ToolSecurityError(`patch context did not match ${path} at hunk ${hunkIndex + 1}`);
    }
    lines = [...lines.slice(0, at), ...hunk.newLines, ...lines.slice(at + hunk.oldLines.length)];
    searchFrom = at + hunk.newLines.length;
  }
  return joinPatchLines(lines, hadTrailingNewline);
}

function requireDelete(fs: FsBackend): NonNullable<FsBackend['deleteFile']> {
  if (!fs.deleteFile) throw new ToolSecurityError('file_patch delete is not supported by this filesystem backend');
  return fs.deleteFile.bind(fs);
}

function requireMove(fs: FsBackend): NonNullable<FsBackend['moveFile']> {
  if (!fs.moveFile) throw new ToolSecurityError('file_patch move is not supported by this filesystem backend');
  return fs.moveFile.bind(fs);
}

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);

const filePatchInput = z.object({
  patch: z.string().min(1),
  strict: z.boolean().optional(),
  baseHashByPath: z.record(z.string(), hashSchema).optional()
});

function providedBaseHash(path: string, options: PatchOptions): string | undefined {
  return options.baseHashByPath?.[path] ?? options.baseHashByPath?.[ledgerPath(path)];
}

async function applyPatchOp(op: PatchOp, ctx: ToolContext, options: PatchOptions): Promise<FileMutationResult> {
  if (op.type === 'add') {
    const content = op.lines.length === 0 ? '' : `${op.lines.join('\n')}\n`;
    return withFsGate(op.path, ctx, { operation: 'write', requestedByTool: 'file_patch' }, async (fs) => {
      const existing = await readExistingText(fs, op.path);
      if (existing !== null) throw new ToolSecurityError(`cannot add existing file: ${op.path}`);
      const { path: written, bytesWritten } = await fs.writeTextFile(op.path, content);
      const mutation = createMutationResult(ctx, written, null, content, 'add', { bytesWritten });
      await rememberObservation(ctx, written, content);
      return mutation;
    });
  }
  if (op.type === 'delete') {
    return withFsGate(op.path, ctx, { operation: 'write', requestedByTool: 'file_patch' }, async (fs) => {
      const before = await fs.readTextFile(op.path);
      await assertObservedOrBaseHash(ctx, op.path, before, options, 'Delete File');
      const deleted = await requireDelete(fs)(op.path);
      return createMutationResult(ctx, deleted.path, before, null, 'delete');
    });
  }
  return withFsGate(op.path, ctx, { operation: 'write', requestedByTool: 'file_patch' }, async (fs) => {
    const before = await fs.readTextFile(op.path);
    if (op.newPath && op.hunks.length === 0) {
      await assertObservedOrBaseHash(ctx, op.path, before, options, 'Move without hunks');
    }
    const after = applyHunks(op.path, before, op.hunks);
    const warning = await observationWarning(ctx, op.path, before);
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
      ...(op.newPath ? { newPath: finalPath } : {}),
      ...(warning ? { warning } : {})
    });
    await rememberObservation(ctx, finalPath, after);
    return mutation;
  });
}

async function applyPatchGroup(
  group: PatchGroup,
  ctx: ToolContext,
  options: PatchOptions
): Promise<FilePatchFileResult[]> {
  const results: FilePatchFileResult[] = [];
  for (const op of group.ops) {
    try {
      results.push(await applyPatchOp(op, ctx, options));
    } catch (err) {
      results.push(mutationError(op, err));
    }
  }
  return results;
}

async function validatePatchGroup(
  group: PatchGroup,
  ctx: ToolContext,
  options: PatchOptions
): Promise<FileMutationError[]> {
  const state = new Map<string, SimulatedFile>();
  const errors: FileMutationError[] = [];
  const getCurrent = async (path: string): Promise<SimulatedFile> => {
    const key = ledgerPath(path);
    const cached = state.get(key);
    if (cached) return cached;
    const text = await withFsGate(path, ctx, { operation: 'read', requestedByTool: 'file_patch' }, async (fs) =>
      readExistingText(fs, path)
    );
    const file = { path, text };
    state.set(key, file);
    return file;
  };
  const putCurrent = (path: string, text: string | null) => {
    state.set(ledgerPath(path), { path, text });
  };

  for (const op of group.ops) {
    try {
      if (op.type === 'add') {
        const existing = await getCurrent(op.path);
        if (existing.text !== null) throw new ToolSecurityError(`cannot add existing file: ${op.path}`);
        putCurrent(op.path, op.lines.length === 0 ? '' : `${op.lines.join('\n')}\n`);
        continue;
      }
      if (op.type === 'delete') {
        const before = await getCurrent(op.path);
        if (before.text === null) throw new ToolSecurityError(`file not found: ${op.path}`);
        await assertObservedOrBaseHash(ctx, op.path, before.text, options, 'Delete File');
        putCurrent(op.path, null);
        continue;
      }
      const before = await getCurrent(op.path);
      if (before.text === null) throw new ToolSecurityError(`file not found: ${op.path}`);
      if (op.newPath && op.hunks.length === 0) {
        await assertObservedOrBaseHash(ctx, op.path, before.text, options, 'Move without hunks');
      }
      const after = applyHunks(op.path, before.text, op.hunks);
      if (op.newPath) {
        const existingDest = await getCurrent(op.newPath);
        if (existingDest.text !== null) throw new ToolSecurityError(`cannot move over existing file: ${op.newPath}`);
        putCurrent(op.path, null);
        putCurrent(op.newPath, after);
      } else {
        putCurrent(op.path, after);
      }
    } catch (err) {
      errors.push(mutationError(op, err));
    }
  }
  return errors;
}

function patchOpPaths(op: PatchOp): Set<string> {
  const paths = new Set([ledgerPath(op.path)]);
  if (op.type === 'update' && op.newPath) paths.add(ledgerPath(op.newPath));
  return paths;
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  for (const value of a) {
    if (b.has(value)) return true;
  }
  return false;
}

function groupPatchOps(ops: PatchOp[]): PatchGroup[] {
  const groups: PatchGroup[] = [];
  for (const op of ops) {
    const paths = patchOpPaths(op);
    const matchingIndexes: number[] = [];
    for (let i = 0; i < groups.length; i++) {
      if (intersects(groups[i]?.paths ?? new Set(), paths)) matchingIndexes.push(i);
    }
    if (matchingIndexes.length === 0) {
      groups.push({ ops: [op], paths });
      continue;
    }
    const first = matchingIndexes[0] as number;
    const merged: PatchGroup = { ops: [], paths: new Set(paths) };
    for (const index of matchingIndexes) {
      const group = groups[index];
      if (!group) continue;
      merged.ops.push(...group.ops);
      for (const path of group.paths) merged.paths.add(path);
    }
    merged.ops.push(op);
    groups.splice(first, 1, merged);
    for (let i = matchingIndexes.length - 1; i >= 1; i--) {
      groups.splice(matchingIndexes[i] as number, 1);
    }
  }
  return groups;
}

export const filePatchTool: Tool<z.infer<typeof filePatchInput>, FileMutationBatchResult> = {
  name: 'file_patch',
  description:
    'Apply a structured patch to files. Supports Add File, Update File, Delete File, and Move to operations. Patch syntax errors stop the whole call. File operation errors are returned per file. Update hunks are applied only when their context matches the current file; different files execute concurrently while repeated operations on the same file run in patch order.',
  scopes: [{ resource: 'fs:write' }],
  needsApproval: (_input, ctx) => !ctx.backends?.fs.delegated && ctx.sandboxRoots === undefined,
  inputSchema: filePatchInput,
  run: async ({ patch, strict, baseHashByPath }, ctx) => {
    const ops = parsePatch(patch);
    const groups = groupPatchOps(ops);
    const options: PatchOptions = baseHashByPath ? { baseHashByPath } : {};
    if (strict) {
      const validationErrors = (
        await Promise.all(groups.map((group) => validatePatchGroup(group, ctx, options)))
      ).flat();
      if (validationErrors.length > 0) {
        const output = fileMutationBatchResult(validationErrors);
        return toolResult(output, {
          modelContent: patchSummary(output),
          displayContent: mutationDisplay(output)
        });
      }
    }
    const results = (await Promise.all(groups.map((group) => applyPatchGroup(group, ctx, options)))).flat();
    const output = fileMutationBatchResult(results);
    return toolResult(output, {
      modelContent: patchSummary(output),
      displayContent: mutationDisplay(output)
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
