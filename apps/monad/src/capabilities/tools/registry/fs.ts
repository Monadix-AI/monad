// Filesystem tools — read / write / edit / glob / grep. Tool arguments are
// attacker-controllable (prompt injection), so every path passes through
// assertPathWithinRoots (lexical `..` defence) AND a realpath re-check (symlink
// escape defence) before the resource is touched.
//
// fs_write / fs_edit are NOT highRisk: the sandbox is the control. The gate is
// all-or-nothing per tool, so gating every edit would make the agent unusable.
// Writes outside the sandbox are blocked by default; the user can grant access
// via the approval gate (once / session / agent). See docs/security-guidelines.md §4.

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
// Built from char code so the source stays pure-ASCII (no literal NUL in a string literal).
const NUL_CHAR = String.fromCharCode(0);
const ALWAYS_IGNORE = ['node_modules', '.git'];
const DISPLAY_TEXT_LIMIT = 8_000;
const MAX_DIFF_LINES = 200;
const MAX_DIFF_CELLS = 40_000;

export interface FsMutationResult {
  path: string;
  bytesWritten?: number;
  replacements?: number;
  beforeHash: string | null;
  afterHash: string;
  changed: boolean;
  diff: string | null;
  diffFormat: 'unified';
  summary: {
    added: number;
    removed: number;
    changed: boolean;
  };
  display: Extract<ToolDisplayContent, { type: 'diff' }>;
}

/** The fs backend for this call: the ACP-delegating one when the session runs over an
 * editor that owns the filesystem, else a sandbox backend over the daemon disk. */
function fsBackend(ctx: ToolContext) {
  return ctx.backends?.fs ?? createSandboxBackends(ctx.sandboxRoots, { defaultCwd: ctx.defaultCwd }).fs;
}

// Bun.Glob.scan may yield OS-native separators on Windows; normalize to forward slashes
// so the ignore filter and callers behave identically on every platform.
const toPosix = (p: string): string => p.replaceAll('\\', '/');

function sha256(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex');
}

function displayPath(path: string, ctx: ToolContext): string {
  const canonicalPath = canonicalize(path);
  // Compare in posix form: realpathSync returns OS-native separators (backslash on Windows), so a
  // `${root}/` prefix check with a hardcoded forward slash never matches on Windows — the file then
  // falls through to its absolute path in the diff header instead of the sandbox-relative one.
  const canonicalPathPosix = toPosix(canonicalPath);
  const root = ctx.sandboxRoots?.find((r) => {
    const canonicalRootPosix = toPosix(canonicalize(r));
    return canonicalPathPosix === canonicalRootPosix || canonicalPathPosix.startsWith(`${canonicalRootPosix}/`);
  });
  return root ? toPosix(relative(canonicalize(root), canonicalPath)) : canonicalPathPosix;
}

function canonicalize(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
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
): FsMutationResult['diff'] {
  return [
    `--- ${path}\tBefore`,
    `+++ ${path}\tAfter`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ...lines,
    ''
  ].join('\n');
}

function fallbackSummary(beforeLines: string[], afterLines: string[]): { added: number; removed: number } {
  return { added: afterLines.length, removed: beforeLines.length };
}

function createDiffSummary(
  path: string,
  before: string | null,
  after: string
): {
  added: number;
  removed: number;
  diff: FsMutationResult['diff'];
  diffSkipped: boolean;
} {
  const oldText = before ?? '';
  const beforeLines = splitDiffLines(oldText);
  const afterLines = splitDiffLines(after);
  if (oldText === after) return { added: 0, removed: 0, diff: null, diffSkipped: false };
  if (shouldSkipDiff(beforeLines, afterLines)) {
    return { ...fallbackSummary(beforeLines, afterLines), diff: null, diffSkipped: true };
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
  after: string,
  extra: Pick<FsMutationResult, 'bytesWritten'> | Pick<FsMutationResult, 'replacements'>
): FsMutationResult {
  const shownPath = displayPath(path, ctx);
  const changed = before !== after;
  const { added, removed, diff, diffSkipped } = createDiffSummary(shownPath, before, after);
  const beforePreview = before === null ? null : displayPreview(before);
  const afterPreview = displayPreview(after);
  const diffPreview = diff === null ? null : displayPreview(diff);
  const display = {
    type: 'diff' as const,
    path,
    beforeText: beforePreview?.text ?? null,
    afterText: afterPreview.text,
    ...(diffPreview ? { diff: diffPreview.text } : {}),
    diffStat: { added, removed },
    ...(beforePreview?.truncated || afterPreview.truncated || diffPreview?.truncated || diffSkipped
      ? { truncated: true }
      : {})
  };
  return {
    path,
    ...extra,
    beforeHash: before === null ? null : sha256(before),
    afterHash: sha256(after),
    changed,
    diff,
    diffFormat: 'unified',
    summary: { added, removed, changed },
    display
  };
}

function mutationSummary(output: FsMutationResult): string {
  const action = output.replacements !== undefined ? `Modified file: ${output.path}` : `Wrote file: ${output.path}`;
  const details =
    output.replacements !== undefined
      ? ` (${output.replacements} replacement${output.replacements === 1 ? '' : 's'})`
      : output.bytesWritten !== undefined
        ? ` (${output.bytesWritten} bytes)`
        : '';
  const delta = `${output.summary.added} added, ${output.summary.removed} removed`;
  return `${action}${details}. ${output.changed ? delta : 'No content changes'}. beforeHash=${output.beforeHash ?? 'new'} afterHash=${output.afterHash}`;
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

/**
 * Run `fn` with the current sandbox backend; on a path-escape error, gate the access and
 * retry with an expanded backend. Transparent for delegated backends (they never throw
 * ToolSecurityError with "path escapes sandbox").
 */
async function withFsGate<T>(path: string, ctx: ToolContext, fn: (fs: FsBackend) => Promise<T>): Promise<T> {
  try {
    return await fn(fsBackend(ctx));
  } catch (err) {
    const expanded = await gatePathAccess(path, ctx, err);
    return fn(createSandboxBackends(expanded, { defaultCwd: ctx.defaultCwd }).fs);
  }
}

const fsReadInput = z.object({
  path: z.string().min(1),
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).optional()
});

export const fsReadTool: Tool<z.infer<typeof fsReadInput>, string> = {
  name: 'fs_read',
  description:
    'Read a UTF-8 text file. Returns lines with 1-based line numbers (format: "N\\tcontent"). Defaults to first 2000 lines; use offset to page through large files.',
  scopes: [{ resource: 'fs:read' }],
  inputSchema: fsReadInput,
  run: async ({ path, offset, limit }, ctx) => {
    const effectiveLimit = limit ?? DEFAULT_READ_LINES;
    const text = await withFsGate(path, ctx, (fs) => fs.readTextFile(path, { offset, limit: effectiveLimit }));
    const startLine = offset ?? 1;
    // Normalize CRLF so Windows files don't emit trailing \r on every output line.
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    // Strip ALL trailing blank lines — a file ending with multiple \n would otherwise
    // produce phantom numbered blank lines.
    while (lines.length > 0 && lines.at(-1) === '') lines.pop();
    const numbered = lines.map((line, i) => `${startLine + i}\t${line}`).join('\n');
    // Add a pagination hint only when the default limit was applied (not an explicit caller
    // limit), so the model knows there is more content to read.
    if (limit === undefined && lines.length === effectiveLimit) {
      return toolResult(`${numbered}\n(truncated; use offset=${startLine + lines.length} to continue)`);
    }
    return toolResult(numbered);
  }
};

const fsWriteInput = z.object({ path: z.string().min(1), content: z.string() });

export const fsWriteTool: Tool<z.infer<typeof fsWriteInput>, FsMutationResult> = {
  name: 'fs_write',
  description:
    'Write (create or overwrite) a UTF-8 text file. Parent directories are created as needed. Constrained to the sandbox by default; the user can grant access to paths outside it via the approval prompt.',
  scopes: [{ resource: 'fs:write' }],
  // Inside a sandbox the path guard already confines writes; only an unrestricted sandbox
  // (no roots) lets a write land anywhere on the host, so gate just that case. When delegated,
  // the editor owns the filesystem and gates the write itself — don't double-prompt.
  needsApproval: (_input, ctx) => !ctx.backends?.fs.delegated && ctx.sandboxRoots === undefined,
  inputSchema: fsWriteInput,
  run: ({ path, content }, ctx) =>
    withFsGate(path, ctx, async (fs) => {
      const before = await readExistingText(fs, path);
      const { path: written, bytesWritten } = await fs.writeTextFile(path, content);
      const result = createMutationResult(ctx, written, before, content, { bytesWritten });
      return toolResult(result, { modelContent: mutationSummary(result), displayContent: result.display });
    })
};

const fsEditInput = z.object({
  path: z.string().min(1),
  oldString: z.string().min(1),
  newString: z.string(),
  // Default false: oldString must be unique — an ambiguous match is a model error,
  // not a silent multi-edit.
  replaceAll: z.boolean().optional()
});

export const fsEditTool: Tool<z.infer<typeof fsEditInput>, FsMutationResult> = {
  name: 'fs_edit',
  description:
    'Replace an exact string in a file. oldString must be unique unless replaceAll is set. Constrained to the sandbox by default; the user can grant access to paths outside it via the approval prompt.',
  scopes: [{ resource: 'fs:write' }],
  needsApproval: (_input, ctx) => !ctx.backends?.fs.delegated && ctx.sandboxRoots === undefined,
  inputSchema: fsEditInput,
  run: async ({ path, oldString, newString, replaceAll }, ctx) => {
    if (oldString === newString) throw new ToolSecurityError('oldString and newString are identical — no-op edit');
    // The diff/replace logic stays in monad; only the read/write primitives are delegated, so
    // an editor-delegated edit still produces a single reviewable write of the final content.
    return withFsGate(path, ctx, async (fs) => {
      const text = await fs.readTextFile(path);
      const count = text.split(oldString).length - 1;
      if (count === 0) throw new ToolSecurityError('oldString not found in file');
      if (count > 1 && !replaceAll) {
        throw new ToolSecurityError(`oldString is not unique (${count} matches) — pass replaceAll or add more context`);
      }
      const next = replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, newString);
      const { path: written } = await fs.writeTextFile(path, next);
      const result = createMutationResult(ctx, written, text, next, { replacements: replaceAll ? count : 1 });
      return toolResult(result, { modelContent: mutationSummary(result), displayContent: result.display });
    });
  }
};

const fsGlobInput = z.object({
  pattern: z.string().min(1),
  path: z.string().optional() // scan directory; defaults to the primary sandbox root
});

export const fsGlobTool: Tool<z.infer<typeof fsGlobInput>, string[]> = {
  name: 'fs_glob',
  description:
    'List files matching a glob pattern (e.g. "src/**/*.ts"), relative to the scan directory. Skips node_modules/.git.',
  scopes: [{ resource: 'fs:read' }],
  inputExamples: [{ pattern: '**/*.ts' }, { pattern: '**/*.test.ts', path: 'packages' }],
  inputSchema: fsGlobInput,
  run: async ({ pattern, path }, ctx) => {
    const scanPath = path ?? ctx.sandboxRoots?.[0] ?? process.cwd();
    let cwd: string;
    try {
      cwd = await resolveReal(scanPath, ctx.sandboxRoots);
    } catch (err) {
      if (!path) throw err; // default path is the sandbox root — can't escape
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

const fsGrepInput = z.object({
  pattern: z.string().min(1), // JS regex source
  path: z.string().optional(),
  glob: z.string().optional(), // file glob to search within; defaults to everything
  flags: z.string().optional() // e.g. "i"
});

export interface GrepMatch {
  file: string; // relative to scan dir
  line: number; // 1-based line number
  text: string;
}

export const fsGrepTool: Tool<z.infer<typeof fsGrepInput>, GrepMatch[]> = {
  name: 'fs_grep',
  description:
    'Search file contents by regex and return matching lines with file + line number. Skips node_modules/.git and large/binary files.',
  scopes: [{ resource: 'fs:read' }],
  inputSchema: fsGrepInput,
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
      if (!path) throw err; // default path is the sandbox root — can't escape
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
      if (text.includes(NUL_CHAR)) continue; // binary file
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        // Strip trailing CR so CRLF files match `$`-anchored patterns.
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

const fsTools: Tool[] = [
  fsReadTool as Tool,
  fsWriteTool as Tool,
  fsEditTool as Tool,
  fsGlobTool as Tool,
  fsGrepTool as Tool
];

// Uniform module entry. fs is a static module — it needs no boot deps, so it ignores `deps`.
export const register: ToolModule = () => fsTools;
