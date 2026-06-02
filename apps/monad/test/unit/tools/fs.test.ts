import type { ToolContext, ToolGate } from '@/capabilities/tools/types.ts';

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fsEditTool, fsGlobTool, fsGrepTool, fsReadTool, fsWriteTool, ToolSecurityError } from '@/capabilities/tools';

let root: string;
const ctx = (roots: string[] | undefined, gate?: ToolGate): ToolContext => ({
  sessionId: 's1',
  sandboxRoots: roots,
  gate,
  log: () => {}
});

/** Gate that immediately allows, recording the calls made to it. */
function allowGate(calls: { tool: string; key?: string }[] = []): ToolGate {
  return async (req) => {
    calls.push({ tool: req.tool, key: req.key });
    return { allow: true };
  };
}

/** Gate that immediately denies. */
const denyGate: ToolGate = async () => ({ allow: false, reason: 'test deny' });

test('fs_write/fs_edit need approval only when the sandbox is unrestricted', () => {
  for (const tool of [fsWriteTool, fsEditTool]) {
    expect(tool.needsApproval?.({} as never, ctx(['/ws']))).toBe(false); // confined → no gate
    expect(tool.needsApproval?.({} as never, ctx(undefined))).toBe(true); // host-wide → gate
  }
});

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'monad-fs-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\nconst secret = "needle";\n');
  await writeFile(join(root, 'src', 'b.ts'), 'export const b = 2;\n');
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test('fs_read returns file contents', async () => {
  const out = await fsReadTool.run({ path: join(root, 'src', 'a.ts') }, ctx([root]));
  expect(out.modelContent).toContain('needle');
});

test('fs_read honours offset/limit', async () => {
  const out = await fsReadTool.run({ path: join(root, 'src', 'a.ts'), offset: 2, limit: 1 }, ctx([root]));
  expect(out.modelContent).toBe('2\tconst secret = "needle";');
});

test('fs_read prefixes lines with 1-based line numbers', async () => {
  const out = await fsReadTool.run({ path: join(root, 'src', 'a.ts') }, ctx([root]));
  expect(out.modelContent).toBe('1\texport const a = 1;\n2\tconst secret = "needle";');
});

test('fs_read strips all trailing blank lines', async () => {
  const p = join(root, 'trailing.txt');
  await fsWriteTool.run({ path: p, content: 'a\nb\n\n' }, ctx([root]));
  expect((await fsReadTool.run({ path: p }, ctx([root]))).modelContent).toBe('1\ta\n2\tb');
});

test('fs_read normalizes CRLF line endings', async () => {
  const p = join(root, 'crlf.txt');
  await fsWriteTool.run({ path: p, content: 'line1\r\nline2\r\n' }, ctx([root]));
  expect((await fsReadTool.run({ path: p }, ctx([root]))).modelContent).toBe('1\tline1\n2\tline2');
});

test('fs_read rejects paths outside the sandbox', async () => {
  await expect(fsReadTool.run({ path: '/etc/passwd' }, ctx([root]))).rejects.toBeInstanceOf(ToolSecurityError);
});

test('fs_read rejects ".." traversal', async () => {
  await expect(fsReadTool.run({ path: join(root, '..', 'escape') }, ctx([root]))).rejects.toBeInstanceOf(
    ToolSecurityError
  );
});

test('fs_write creates files (and parent dirs) inside the sandbox', async () => {
  const p = join(root, 'nested', 'new.txt');
  const res = (await fsWriteTool.run({ path: p, content: 'hello' }, ctx([root]))).metadata;
  expect(res.bytesWritten).toBe(5);
  expect(res.changed).toBe(true);
  expect(res.diff).toContain('--- nested/new.txt\tBefore');
  expect(res.diff).toContain('+++ nested/new.txt\tAfter');
  expect(res.diff).toContain('+hello');
  expect(res.beforeHash).toBeNull();
  expect(res.afterHash).toMatch(/^[a-f0-9]{64}$/);
  expect(res.display).toMatchObject({
    type: 'diff',
    path: res.path,
    beforeText: null,
    afterText: 'hello'
  });
  expect((await fsReadTool.run({ path: p }, ctx([root]))).modelContent).toBe('1\thello');
});

test('fs_write is blocked outside the sandbox', async () => {
  await expect(fsWriteTool.run({ path: '/tmp/evil.txt', content: 'x' }, ctx([root]))).rejects.toBeInstanceOf(
    ToolSecurityError
  );
});

test('fs_edit replaces a unique string', async () => {
  const p = join(root, 'edit.txt');
  await fsWriteTool.run({ path: p, content: 'foo bar baz' }, ctx([root]));
  const res = (await fsEditTool.run({ path: p, oldString: 'bar', newString: 'QUX' }, ctx([root]))).metadata;
  expect(res.replacements).toBe(1);
  expect(res.changed).toBe(true);
  expect(res.diff).toContain('-foo bar baz');
  expect(res.diff).toContain('+foo QUX baz');
  expect(res.beforeHash).toMatch(/^[a-f0-9]{64}$/);
  expect(res.afterHash).toMatch(/^[a-f0-9]{64}$/);
  expect(res.beforeHash).not.toBe(res.afterHash);
  expect(res.display).toMatchObject({
    type: 'diff',
    path: res.path,
    beforeText: 'foo bar baz',
    afterText: 'foo QUX baz'
  });
  expect((await fsReadTool.run({ path: p }, ctx([root]))).modelContent).toBe('1\tfoo QUX baz');
});

test('fs_write caps full before/after text in display payloads for large files', async () => {
  const p = join(root, 'large.txt');
  const content = `${'a'.repeat(12_000)}\n`;
  const res = (await fsWriteTool.run({ path: p, content }, ctx([root]))).metadata;
  expect(res.display.afterText.length).toBeLessThan(content.length);
  expect(res.display.diff?.length).toBeLessThan(content.length);
  expect(res.display.truncated).toBe(true);
  expect(res.diff).toContain('+');
  expect(res.afterHash).toMatch(/^[a-f0-9]{64}$/);
});

test('fs_write skips unified diff generation for large line counts', async () => {
  const p = join(root, 'large-lines.txt');
  const content = `${Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n')}\n`;
  const res = (await fsWriteTool.run({ path: p, content }, ctx([root]))).metadata;
  expect(res.changed).toBe(true);
  expect(res.diff).toBeNull();
  expect(res.summary.added).toBe(300);
  expect(res.summary.removed).toBe(0);
  expect(res.display.diff).toBeUndefined();
  expect(res.display.truncated).toBe(true);
  expect(res.afterHash).toMatch(/^[a-f0-9]{64}$/);
});

test('fs_edit refuses an ambiguous match unless replaceAll', async () => {
  const p = join(root, 'dup.txt');
  await fsWriteTool.run({ path: p, content: 'x x x' }, ctx([root]));
  await expect(fsEditTool.run({ path: p, oldString: 'x', newString: 'y' }, ctx([root]))).rejects.toBeInstanceOf(
    ToolSecurityError
  );
  const res = (await fsEditTool.run({ path: p, oldString: 'x', newString: 'y', replaceAll: true }, ctx([root])))
    .metadata;
  expect(res.replacements).toBe(3);
});

test('fs_glob lists matching files relative to the scan dir', async () => {
  const out = await fsGlobTool.run({ pattern: 'src/**/*.ts', path: root }, ctx([root]));
  expect(out.metadata).toEqual(['src/a.ts', 'src/b.ts']);
});

test('fs_grep finds matching lines with line numbers', async () => {
  const out = await fsGrepTool.run({ pattern: 'needle', path: root }, ctx([root]));
  expect(out.metadata.length).toBe(1);
  expect(out.metadata[0]).toMatchObject({ file: 'src/a.ts', line: 2 });
});

// ── Path-escalation (gate) tests ──────────────────────────────────────────────

let outside: string; // a tmp dir outside `root`, used as the "Desktop" stand-in
let outsideFile: string;

beforeAll(async () => {
  outside = await mkdtemp(join(tmpdir(), 'monad-fs-outside-'));
  outsideFile = join(outside, 'secret.txt');
  await writeFile(outsideFile, 'outside content');
});
afterAll(async () => {
  await rm(outside, { recursive: true, force: true });
});

test('fs_write outside sandbox: no gate → throws', async () => {
  await expect(fsWriteTool.run({ path: outsideFile, content: 'x' }, ctx([root]))).rejects.toBeInstanceOf(
    ToolSecurityError
  );
});

test('fs_write outside sandbox: deny gate → still throws', async () => {
  await expect(fsWriteTool.run({ path: outsideFile, content: 'x' }, ctx([root], denyGate))).rejects.toBeInstanceOf(
    ToolSecurityError
  );
});

test('fs_write outside sandbox: allow gate → succeeds and uses fs_path_access key', async () => {
  const calls: { tool: string; key?: string }[] = [];
  const p = join(outside, 'written.txt');
  const res = (await fsWriteTool.run({ path: p, content: 'via gate' }, ctx([root], allowGate(calls)))).metadata;
  expect(res.bytesWritten).toBe(8);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.tool).toBe('fs_path_access');
  expect(calls[0]?.key).toBe(outside); // key = parent dir of the file
});

test('fs_read outside sandbox: allow gate → succeeds', async () => {
  const res = await fsReadTool.run({ path: outsideFile }, ctx([root], allowGate()));
  expect(res.modelContent).toContain('outside content');
});

test('fs_edit outside sandbox: allow gate → succeeds', async () => {
  const p = join(outside, 'edit-gate.txt');
  await fsWriteTool.run({ path: p, content: 'hello world' }, ctx([root], allowGate()));
  const res = (await fsEditTool.run({ path: p, oldString: 'world', newString: 'gate' }, ctx([root], allowGate())))
    .metadata;
  expect(res.replacements).toBe(1);
});

test('fs_glob outside sandbox: allow gate → lists files', async () => {
  const out = await fsGlobTool.run({ pattern: '*.txt', path: outside }, ctx([root], allowGate()));
  expect(out.metadata).toContain('secret.txt');
});

test('gate is only called once per path-escape (not on in-sandbox paths)', async () => {
  const calls: { tool: string; key?: string }[] = [];
  await fsReadTool.run({ path: join(root, 'src', 'a.ts') }, ctx([root], allowGate(calls)));
  expect(calls).toHaveLength(0); // within sandbox — gate never consulted
});
