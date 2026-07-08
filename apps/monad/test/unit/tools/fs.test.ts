import type { ToolContext, ToolGate } from '@/capabilities/tools/types.ts';

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  fileGlobTool,
  fileGrepTool,
  filePatchTool,
  fileReadTool,
  fileWriteTool,
  ToolSecurityError
} from '@/capabilities/tools';

let root: string;
let sessionCounter = 0;
const ctx = (roots: string[] | undefined, gate?: ToolGate): ToolContext => ({
  sessionId: `s${++sessionCounter}`,
  sandboxRoots: roots,
  gate,
  log: () => {}
});

function sha256(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex');
}

function allowGate(calls: { tool: string; key?: string }[] = []): ToolGate {
  return async (req) => {
    calls.push({ tool: req.tool, key: req.key });
    return { allow: true };
  };
}

const denyGate: ToolGate = async () => ({ allow: false, reason: 'test deny' });

test('file_write/file_patch need approval only when the sandbox is unrestricted', () => {
  for (const tool of [fileWriteTool, filePatchTool]) {
    expect(tool.needsApproval?.({} as never, ctx(['/ws']))).toBe(false);
    expect(tool.needsApproval?.({} as never, ctx(undefined))).toBe(true);
  }
});

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'monad-file-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\nconst secret = "needle";\n');
  await writeFile(join(root, 'src', 'b.ts'), 'export const b = 2;\n');
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test('file_read returns file contents', async () => {
  const out = await fileReadTool.run({ path: join(root, 'src', 'a.ts') }, ctx([root]));
  expect(out.modelContent).toContain('export const a = 1;');
});

test('file_read honours offset/limit', async () => {
  const out = await fileReadTool.run({ path: join(root, 'src', 'a.ts'), offset: 2, limit: 1 }, ctx([root]));
  expect(out.modelContent).toBe('2\tconst secret = "needle";');
});

test('file_read prefixes lines with 1-based line numbers', async () => {
  const out = await fileReadTool.run({ path: join(root, 'src', 'a.ts') }, ctx([root]));
  expect(out.modelContent).toBe('1\texport const a = 1;\n2\tconst secret = "needle";');
});

test('file_read strips all trailing blank lines', async () => {
  const p = join(root, 'trailing.txt');
  await fileWriteTool.run({ path: p, content: 'a\nb\n\n' }, ctx([root]));
  expect((await fileReadTool.run({ path: p }, ctx([root]))).modelContent).toBe('1\ta\n2\tb');
});

test('file_read normalizes CRLF line endings', async () => {
  const p = join(root, 'crlf.txt');
  await fileWriteTool.run({ path: p, content: 'line1\r\nline2\r\n' }, ctx([root]));
  expect((await fileReadTool.run({ path: p }, ctx([root]))).modelContent).toBe('1\tline1\n2\tline2');
});

test('file_read rejects paths outside the sandbox', async () => {
  await expect(fileReadTool.run({ path: '/etc/passwd' }, ctx([root]))).rejects.toBeInstanceOf(ToolSecurityError);
});

test('file_read rejects ".." traversal', async () => {
  await expect(fileReadTool.run({ path: join(root, '..', 'escape') }, ctx([root]))).rejects.toBeInstanceOf(
    ToolSecurityError
  );
});

test('file_write creates files and parent dirs inside the sandbox', async () => {
  const p = join(root, 'nested', 'new.txt');
  const res = (await fileWriteTool.run({ path: p, content: 'hello' }, ctx([root]))).metadata;
  expect(res.bytesWritten).toBe(5);
  expect(res.changed).toBe(true);
  expect(res.afterHash).toMatch(/^[a-f0-9]{64}$/);
  expect(res.display).toMatchObject({
    type: 'diff',
    path: res.path,
    beforeText: null,
    afterText: 'hello'
  });
  expect((await fileReadTool.run({ path: p }, ctx([root]))).modelContent).toBe('1\thello');
});

test('file_write blocks overwrite when the file was not read first', async () => {
  const p = join(root, 'unread-overwrite.txt');
  await writeFile(p, 'before');
  await expect(fileWriteTool.run({ path: p, content: 'after' }, ctx([root]))).rejects.toThrow(
    'File has not been read yet'
  );
});

test('file_write overwrites after file_read records the current hash', async () => {
  const p = join(root, 'read-overwrite.txt');
  const c = ctx([root]);
  await writeFile(p, 'before');
  await fileReadTool.run({ path: p }, c);
  const res = (await fileWriteTool.run({ path: p, content: 'after' }, c)).metadata;
  expect(res.beforeHash).toBe(sha256('before'));
  expect(res.afterHash).toBe(sha256('after'));
  expect(await readFile(p, 'utf8')).toBe('after');
});

test('file_write rejects overwrite when the file changed after read', async () => {
  const p = join(root, 'stale-overwrite.txt');
  const c = ctx([root]);
  await writeFile(p, 'before');
  await fileReadTool.run({ path: p }, c);
  await writeFile(p, 'changed');
  await expect(fileWriteTool.run({ path: p, content: 'after' }, c)).rejects.toThrow(
    'File has been modified since read'
  );
});

test('file_write allows explicit whole-file overwrite with matching baseHash', async () => {
  const p = join(root, 'basehash-overwrite.txt');
  await writeFile(p, 'before');
  const res = (await fileWriteTool.run({ path: p, content: 'after', baseHash: sha256('before') }, ctx([root])))
    .metadata;
  expect(res.beforeHash).toBe(sha256('before'));
  expect(res.afterHash).toBe(sha256('after'));
});

test('file_write is blocked outside the sandbox', async () => {
  await expect(fileWriteTool.run({ path: '/tmp/evil.txt', content: 'x' }, ctx([root]))).rejects.toBeInstanceOf(
    ToolSecurityError
  );
});

test('file_write caps full before/after text in display payloads for large files', async () => {
  const p = join(root, 'large.txt');
  const c = ctx([root]);
  await writeFile(p, 'small');
  await fileReadTool.run({ path: p }, c);
  const content = `${'a'.repeat(12_000)}\n`;
  const res = (await fileWriteTool.run({ path: p, content }, c)).metadata;
  expect(res.display.afterText.length).toBeLessThan(content.length);
  expect(res.display.diff?.length).toBeLessThan(content.length);
  expect(res.display.truncated).toBe(true);
  expect(res.afterHash).toMatch(/^[a-f0-9]{64}$/);
});

test('file_write skips unified diff generation for large line counts', async () => {
  const p = join(root, 'large-lines.txt');
  const content = `${Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n')}\n`;
  const res = (await fileWriteTool.run({ path: p, content }, ctx([root]))).metadata;
  expect(res.changed).toBe(true);
  expect(res.summary.added).toBe(300);
  expect(res.summary.removed).toBe(0);
  expect(res.display.truncated).toBe(true);
  expect(res.afterHash).toMatch(/^[a-f0-9]{64}$/);
});

test('file_glob lists matching files relative to the scan dir', async () => {
  const out = await fileGlobTool.run({ pattern: 'src/**/*.ts', path: root }, ctx([root]));
  expect(out.metadata).toEqual(['src/a.ts', 'src/b.ts']);
});

test('file_grep finds matching lines with line numbers', async () => {
  const out = await fileGrepTool.run({ pattern: 'needle', path: root }, ctx([root]));
  expect(out.metadata.length).toBe(1);
  expect(out.metadata[0]).toMatchObject({ file: 'src/a.ts', line: 2 });
});

test('file_patch adds a new file', async () => {
  const p = join(root, 'patch-add.txt');
  const out = await filePatchTool.run(
    {
      patch: `*** Begin Patch
*** Add File: ${p}
+alpha
+beta
*** End Patch`
    },
    ctx([root])
  );
  expect(out.metadata.files[0]).toMatchObject({ operation: 'add', changed: true });
  expect(out.metadata.touchedFiles).toHaveLength(1);
  expect(out.metadata.touchedFiles[0]?.endsWith('/patch-add.txt')).toBe(true);
  expect(await readFile(p, 'utf8')).toBe('alpha\nbeta\n');
});

test('file_patch refuses update when the file was not read first', async () => {
  const p = join(root, 'patch-unread.txt');
  await writeFile(p, 'before\n');
  await expect(
    filePatchTool.run(
      {
        patch: `*** Begin Patch
*** Update File: ${p}
@@
-before
+after
*** End Patch`
      },
      ctx([root])
    )
  ).rejects.toThrow('File has not been read yet');
});

test('file_patch updates after file_read records the current hash', async () => {
  const p = join(root, 'patch-update.txt');
  const c = ctx([root]);
  await writeFile(p, 'one\ntwo\nthree\n');
  await fileReadTool.run({ path: p }, c);
  const out = await filePatchTool.run(
    {
      patch: `*** Begin Patch
*** Update File: ${p}
@@
 one
-two
+TWO
 three
*** End Patch`
    },
    c
  );
  expect(out.metadata.files[0]).toMatchObject({ operation: 'update', changed: true });
  expect(await readFile(p, 'utf8')).toBe('one\nTWO\nthree\n');
});

test('file_patch applies multiple file operations', async () => {
  const update = join(root, 'patch-multi-update.txt');
  const add = join(root, 'patch-multi-add.txt');
  const c = ctx([root]);
  await writeFile(update, 'old\n');
  await fileReadTool.run({ path: update }, c);
  const out = await filePatchTool.run(
    {
      patch: `*** Begin Patch
*** Update File: ${update}
@@
-old
+new
*** Add File: ${add}
+created
*** End Patch`
    },
    c
  );
  expect(out.metadata.files).toHaveLength(2);
  expect(out.metadata.touchedFiles.map((p) => p.split('/').at(-1))).toEqual([
    'patch-multi-update.txt',
    'patch-multi-add.txt'
  ]);
  expect(await readFile(update, 'utf8')).toBe('new\n');
  expect(await readFile(add, 'utf8')).toBe('created\n');
});

test('file_patch deletes a previously read file', async () => {
  const p = join(root, 'patch-delete.txt');
  const c = ctx([root]);
  await writeFile(p, 'delete me\n');
  await fileReadTool.run({ path: p }, c);
  const out = await filePatchTool.run(
    {
      patch: `*** Begin Patch
*** Delete File: ${p}
*** End Patch`
    },
    c
  );
  expect(out.metadata.files[0]).toMatchObject({ operation: 'delete', afterHash: null });
  await expect(Bun.file(p).exists()).resolves.toBe(false);
});

test('file_patch moves a previously read file', async () => {
  const from = join(root, 'patch-move-from.txt');
  const to = join(root, 'patch-move-to.txt');
  const c = ctx([root]);
  await writeFile(from, 'move me\n');
  await fileReadTool.run({ path: from }, c);
  const out = await filePatchTool.run(
    {
      patch: `*** Begin Patch
*** Update File: ${from}
*** Move to: ${to}
*** End Patch`
    },
    c
  );
  expect(out.metadata.files[0]).toMatchObject({ operation: 'move' });
  expect(out.metadata.files[0]?.path.endsWith('/patch-move-from.txt')).toBe(true);
  expect(out.metadata.files[0]?.newPath?.endsWith('/patch-move-to.txt')).toBe(true);
  await expect(readFile(from, 'utf8')).rejects.toThrow();
  expect(await readFile(to, 'utf8')).toBe('move me\n');
});

test('file_patch rejects context mismatches', async () => {
  const p = join(root, 'patch-context.txt');
  const c = ctx([root]);
  await writeFile(p, 'actual\n');
  await fileReadTool.run({ path: p }, c);
  await expect(
    filePatchTool.run(
      {
        patch: `*** Begin Patch
*** Update File: ${p}
@@
-expected
+after
*** End Patch`
      },
      c
    )
  ).rejects.toThrow('patch context did not match');
});

let outside: string;
let outsideFile: string;

beforeAll(async () => {
  outside = await mkdtemp(join(tmpdir(), 'monad-file-outside-'));
  outsideFile = join(outside, 'secret.txt');
  await writeFile(outsideFile, 'outside content');
});
afterAll(async () => {
  await rm(outside, { recursive: true, force: true });
});

test('file_write outside sandbox: no gate throws', async () => {
  await expect(fileWriteTool.run({ path: outsideFile, content: 'x' }, ctx([root]))).rejects.toBeInstanceOf(
    ToolSecurityError
  );
});

test('file_write outside sandbox: deny gate still throws', async () => {
  await expect(fileWriteTool.run({ path: outsideFile, content: 'x' }, ctx([root], denyGate))).rejects.toBeInstanceOf(
    ToolSecurityError
  );
});

test('file_write outside sandbox: allow gate succeeds and uses fs_path_access key', async () => {
  const calls: { tool: string; key?: string }[] = [];
  const p = join(outside, 'written.txt');
  const res = (await fileWriteTool.run({ path: p, content: 'via gate' }, ctx([root], allowGate(calls)))).metadata;
  expect(res.bytesWritten).toBe(8);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.tool).toBe('fs_path_access');
  expect(calls[0]?.key).toBe(outside);
});

test('file_read outside sandbox: allow gate succeeds', async () => {
  const res = await fileReadTool.run({ path: outsideFile }, ctx([root], allowGate()));
  expect(res.modelContent).toBe('1\toutside content');
});

test('file_patch outside sandbox: allow gate succeeds after file_read', async () => {
  const p = join(outside, 'patch-gate.txt');
  const c = ctx([root], allowGate());
  await writeFile(p, 'hello world\n');
  await fileReadTool.run({ path: p }, c);
  const res = (
    await filePatchTool.run(
      {
        patch: `*** Begin Patch
*** Update File: ${p}
@@
-hello world
+hello gate
*** End Patch`
      },
      c
    )
  ).metadata;
  expect(res.files[0]?.summary).toMatchObject({ added: 1, removed: 1, changed: true });
});

test('file_glob outside sandbox: allow gate lists files', async () => {
  const out = await fileGlobTool.run({ pattern: '*.txt', path: outside }, ctx([root], allowGate()));
  expect(out.metadata).toContain('secret.txt');
});

test('gate is only called once per path-escape and not on in-sandbox paths', async () => {
  const calls: { tool: string; key?: string }[] = [];
  await fileReadTool.run({ path: join(root, 'src', 'a.ts') }, ctx([root], allowGate(calls)));
  expect(calls).toHaveLength(0);
});
