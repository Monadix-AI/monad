import type { FileObservationStore, ToolBackends, ToolContext, ToolGate } from '@/capabilities/tools/types.ts';

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
const observations = new Map<string, Awaited<ReturnType<FileObservationStore['get']>>>();
const fileObservations: FileObservationStore = {
  remember(sessionId, observation) {
    observations.set(`${sessionId}:${observation.path}`, observation);
  },
  get(sessionId, path) {
    return observations.get(`${sessionId}:${path}`) ?? null;
  }
};
const ctx = (roots: string[] | undefined, gate?: ToolGate, sessionId = `s${++sessionCounter}`): ToolContext => ({
  sessionId,
  sandboxRoots: roots,
  fileObservations,
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
  expect(res.files[0]?.status).toBe('ok');
  const file = res.files[0]?.status === 'ok' ? res.files[0] : undefined;
  if (!file) throw new Error('expected file_write mutation');
  expect(file?.bytesWritten).toBe(5);
  expect(res.changed).toBe(true);
  expect(file?.afterHash).toMatch(/^[a-f0-9]{64}$/);
  expect(file?.display).toMatchObject({
    type: 'diff',
    path: file.path,
    beforeText: null,
    afterText: 'hello'
  });
  expect((await fileReadTool.run({ path: p }, ctx([root]))).modelContent).toBe('1\thello');
});

test('file_write blocks overwrite when the file was not read first', async () => {
  const p = join(root, 'unread-overwrite.txt');
  await writeFile(p, 'before');
  await expect(fileWriteTool.run({ path: p, content: 'after' }, ctx([root]))).rejects.toThrow(
    'File has not been observed in this session'
  );
});

test('file_write overwrites after file_read records the current hash', async () => {
  const p = join(root, 'read-overwrite.txt');
  const c = ctx([root]);
  await writeFile(p, 'before');
  await fileReadTool.run({ path: p }, c);
  const res = (await fileWriteTool.run({ path: p, content: 'after' }, c)).metadata;
  expect(res.files[0]).toMatchObject({ status: 'ok', beforeHash: sha256('before'), afterHash: sha256('after') });
  expect(await readFile(p, 'utf8')).toBe('after');
});

test('file_write uses session observations after ToolContext recreation', async () => {
  const p = join(root, 'persisted-observation-overwrite.txt');
  const sessionId = `s${++sessionCounter}`;
  await writeFile(p, 'before');
  await fileReadTool.run({ path: p }, ctx([root], undefined, sessionId));
  const res = (await fileWriteTool.run({ path: p, content: 'after' }, ctx([root], undefined, sessionId))).metadata;
  expect(res.files[0]).toMatchObject({ status: 'ok', beforeHash: sha256('before'), afterHash: sha256('after') });
  expect(await readFile(p, 'utf8')).toBe('after');
});

test('file_write does not treat partial file_read as a whole-file observation', async () => {
  const p = join(root, 'partial-read-overwrite.txt');
  const c = ctx([root]);
  await writeFile(p, `${Array.from({ length: 2105 }, (_, i) => `line ${i}`).join('\n')}\n`);
  await fileReadTool.run({ path: p }, c);
  await expect(fileWriteTool.run({ path: p, content: 'after\n' }, c)).rejects.toThrow(
    'File has not been observed in this session'
  );
  await fileReadTool.run({ path: p, offset: 2001, limit: 200 }, c);
  await expect(fileWriteTool.run({ path: p, content: 'after\n' }, c)).rejects.toThrow(
    'File has not been observed in this session'
  );
});

test('file_write rejects overwrite when the file changed after read', async () => {
  const p = join(root, 'stale-overwrite.txt');
  const c = ctx([root]);
  await writeFile(p, 'before');
  await fileReadTool.run({ path: p }, c);
  await writeFile(p, 'changed');
  await expect(fileWriteTool.run({ path: p, content: 'after' }, c)).rejects.toThrow(
    'File has changed since the session observation'
  );
});

test('file_write allows explicit whole-file overwrite with matching baseHash', async () => {
  const p = join(root, 'basehash-overwrite.txt');
  await writeFile(p, 'before');
  const res = (await fileWriteTool.run({ path: p, content: 'after', baseHash: sha256('before') }, ctx([root])))
    .metadata;
  expect(res.files[0]).toMatchObject({ status: 'ok', beforeHash: sha256('before'), afterHash: sha256('after') });
});

test('file_write reports baseHash mismatch with canonical path and hashes', async () => {
  const p = join(root, 'basehash-mismatch.txt');
  await writeFile(p, 'before');
  await expect(
    fileWriteTool.run({ path: p, content: 'after', baseHash: sha256('stale') }, ctx([root]))
  ).rejects.toThrow(
    new RegExp(
      `baseHash does not match current file for .+basehash-mismatch\\.txt\\. expected=${sha256('stale')} current=${sha256('before')}`
    )
  );
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
  const file = res.files[0]?.status === 'ok' ? res.files[0] : undefined;
  expect(file?.display.afterText.length).toBeLessThan(content.length);
  expect(file?.display.diff?.length).toBeLessThan(content.length);
  expect(file?.display.truncated).toBe(true);
  expect(file?.afterHash).toMatch(/^[a-f0-9]{64}$/);
});

test('file_write skips unified diff generation for large line counts', async () => {
  const p = join(root, 'large-lines.txt');
  const content = `${Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n')}\n`;
  const res = (await fileWriteTool.run({ path: p, content }, ctx([root]))).metadata;
  expect(res.changed).toBe(true);
  expect(res.summary.added).toBe(300);
  expect(res.summary.removed).toBe(0);
  const file = res.files[0]?.status === 'ok' ? res.files[0] : undefined;
  expect(file?.display.truncated).toBe(true);
  expect(file?.afterHash).toMatch(/^[a-f0-9]{64}$/);
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

test('file_patch updates without a prior read when context matches', async () => {
  const p = join(root, 'patch-unread.txt');
  await writeFile(p, 'before\n');
  const out = await filePatchTool.run(
    {
      patch: `*** Begin Patch
*** Update File: ${p}
@@
-before
+after
*** End Patch`
    },
    ctx([root])
  );
  expect(out.metadata).toMatchObject({ succeeded: 1, failed: 0, changed: true });
  expect(await readFile(p, 'utf8')).toBe('after\n');
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

test('file_patch updates when full-file hash changed but hunk context matches', async () => {
  const p = join(root, 'patch-observation-drift.txt');
  const c = ctx([root]);
  await writeFile(p, 'target\nuntouched\n');
  await fileReadTool.run({ path: p }, c);
  await writeFile(p, 'target\nexternal\n');
  const out = await filePatchTool.run(
    {
      baseHashByPath: { [p]: sha256('target\nuntouched\n') },
      patch: `*** Begin Patch
*** Update File: ${p}
@@
-target
+updated
*** End Patch`
    },
    c
  );
  expect(out.metadata.files[0]).toMatchObject({ status: 'ok', operation: 'update' });
  expect(out.metadata.files[0]?.status === 'ok' ? out.metadata.files[0].warning : undefined).toContain(
    'hunk context matched'
  );
  expect(out.modelContent).toContain('1 warning');
  expect(await readFile(p, 'utf8')).toBe('updated\nexternal\n');
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

test('file_patch returns per-file errors while applying other files', async () => {
  const good = join(root, 'patch-partial-good.txt');
  const bad = join(root, 'patch-partial-bad.txt');
  await writeFile(good, 'old\n');
  await writeFile(bad, 'actual\n');
  const out = await filePatchTool.run(
    {
      patch: `*** Begin Patch
*** Update File: ${good}
@@
-old
+new
*** Update File: ${bad}
@@
-expected
+after
*** End Patch`
    },
    ctx([root])
  );
  expect(out.metadata).toMatchObject({ succeeded: 1, failed: 1, changed: true });
  expect(out.metadata.files.map((file) => file.status)).toEqual(['ok', 'error']);
  expect(out.metadata.files[1]).toMatchObject({ status: 'error', path: bad });
  expect(out.modelContent).toContain('Some files were already modified');
  expect(await readFile(good, 'utf8')).toBe('new\n');
  expect(await readFile(bad, 'utf8')).toBe('actual\n');
});

test('file_patch strict mode validates all files before writing', async () => {
  const good = join(root, 'patch-strict-good.txt');
  const bad = join(root, 'patch-strict-bad.txt');
  await writeFile(good, 'old\n');
  await writeFile(bad, 'actual\n');
  const out = await filePatchTool.run(
    {
      strict: true,
      patch: `*** Begin Patch
*** Update File: ${good}
@@
-old
+new
*** Update File: ${bad}
@@
-expected
+after
*** End Patch`
    },
    ctx([root])
  );
  expect(out.metadata).toMatchObject({ succeeded: 0, failed: 1, changed: false });
  expect(out.metadata.files[0]).toMatchObject({ status: 'error', path: bad });
  expect(await readFile(good, 'utf8')).toBe('old\n');
  expect(await readFile(bad, 'utf8')).toBe('actual\n');
});

test('file_patch strict mode writes after validation succeeds', async () => {
  const first = join(root, 'patch-strict-first.txt');
  const second = join(root, 'patch-strict-second.txt');
  await writeFile(first, 'a\n');
  await writeFile(second, 'b\n');
  const out = await filePatchTool.run(
    {
      strict: true,
      patch: `*** Begin Patch
*** Update File: ${first}
@@
-a
+aa
*** Update File: ${second}
@@
-b
+bb
*** End Patch`
    },
    ctx([root])
  );
  expect(out.metadata).toMatchObject({ succeeded: 2, failed: 0, changed: true });
  expect(await readFile(first, 'utf8')).toBe('aa\n');
  expect(await readFile(second, 'utf8')).toBe('bb\n');
});

test('file_patch preserves files without trailing newline', async () => {
  const p = join(root, 'patch-no-newline.txt');
  await writeFile(p, 'before');
  const out = await filePatchTool.run(
    {
      patch: `*** Begin Patch
*** Update File: ${p}
@@
-before
+after
*** End Patch`
    },
    ctx([root])
  );
  expect(out.metadata).toMatchObject({ succeeded: 1, failed: 0 });
  expect(await readFile(p, 'utf8')).toBe('after');
});

test('file_patch executes independent file operations concurrently', async () => {
  const files = new Map([
    ['/a.txt', 'old\n'],
    ['/b.txt', 'old\n']
  ]);
  let activeWrites = 0;
  let maxActiveWrites = 0;
  const backends: ToolBackends = {
    fs: {
      delegated: true,
      async readTextFile(path) {
        const text = files.get(path);
        if (text === undefined) throw new Error('not found');
        return text;
      },
      async writeTextFile(path, content) {
        activeWrites++;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
        await Bun.sleep(20);
        files.set(path, content);
        activeWrites--;
        return { path, bytesWritten: content.length };
      }
    },
    terminal: {
      delegated: true,
      async exec() {
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
      }
    }
  };
  const out = await filePatchTool.run(
    {
      patch: `*** Begin Patch
*** Update File: /a.txt
@@
-old
+new a
*** Update File: /b.txt
@@
-old
+new b
*** End Patch`
    },
    { ...ctx(undefined), backends }
  );
  expect(out.metadata).toMatchObject({ succeeded: 2, failed: 0 });
  expect(maxActiveWrites).toBeGreaterThan(1);
});

test('file_patch runs repeated operations on the same file in order', async () => {
  const files = new Map([['/same.txt', 'a\n']]);
  let activeWrites = 0;
  let maxActiveWrites = 0;
  const backends: ToolBackends = {
    fs: {
      delegated: true,
      async readTextFile(path) {
        const text = files.get(path);
        if (text === undefined) throw new Error('not found');
        return text;
      },
      async writeTextFile(path, content) {
        activeWrites++;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
        await Bun.sleep(20);
        files.set(path, content);
        activeWrites--;
        return { path, bytesWritten: content.length };
      }
    },
    terminal: {
      delegated: true,
      async exec() {
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
      }
    }
  };
  const out = await filePatchTool.run(
    {
      patch: `*** Begin Patch
*** Update File: /same.txt
@@
-a
+b
*** Update File: /same.txt
@@
-b
+c
*** End Patch`
    },
    { ...ctx(undefined), backends }
  );
  expect(out.metadata).toMatchObject({ succeeded: 2, failed: 0 });
  expect(maxActiveWrites).toBe(1);
  expect(files.get('/same.txt')).toBe('c\n');
});

test('file_patch syntax errors fail the whole tool call', async () => {
  await expect(filePatchTool.run({ patch: '*** Add File: bad.txt\n+bad' }, ctx([root]))).rejects.toThrow(
    'patch must start'
  );
});

test('file_patch requires observation or baseHash for delete operations', async () => {
  const p = join(root, 'patch-delete-without-hash.txt');
  await writeFile(p, 'delete me\n');
  const out = await filePatchTool.run(
    {
      patch: `*** Begin Patch
*** Delete File: ${p}
*** End Patch`
    },
    ctx([root])
  );
  expect(out.metadata).toMatchObject({ succeeded: 0, failed: 1, changed: false });
  expect(out.metadata.files[0]).toMatchObject({ status: 'error', operation: 'delete' });
  expect(await readFile(p, 'utf8')).toBe('delete me\n');
});

test('file_patch deletes with a matching baseHash', async () => {
  const p = join(root, 'patch-delete.txt');
  const content = 'delete me\n';
  await writeFile(p, content);
  const out = await filePatchTool.run(
    {
      baseHashByPath: { [p]: sha256(content) },
      patch: `*** Begin Patch
*** Delete File: ${p}
*** End Patch`
    },
    ctx([root])
  );
  expect(out.metadata.files[0]).toMatchObject({ operation: 'delete', afterHash: null });
});

test('file_patch deletes with a persisted session observation', async () => {
  const p = join(root, 'patch-delete-observed.txt');
  const sessionId = `s${++sessionCounter}`;
  await writeFile(p, 'delete me\n');
  await fileReadTool.run({ path: p }, ctx([root], undefined, sessionId));
  const out = await filePatchTool.run(
    {
      patch: `*** Begin Patch
*** Delete File: ${p}
*** End Patch`
    },
    ctx([root], undefined, sessionId)
  );
  expect(out.metadata.files[0]).toMatchObject({ operation: 'delete', afterHash: null });
});

test('file_patch requires observation or baseHash for move without hunks', async () => {
  const from = join(root, 'patch-move-without-hash-from.txt');
  const to = join(root, 'patch-move-without-hash-to.txt');
  await writeFile(from, 'move me\n');
  const out = await filePatchTool.run(
    {
      patch: `*** Begin Patch
*** Update File: ${from}
*** Move to: ${to}
*** End Patch`
    },
    ctx([root])
  );
  expect(out.metadata).toMatchObject({ succeeded: 0, failed: 1, changed: false });
  expect(out.metadata.files[0]).toMatchObject({ status: 'error', operation: 'move' });
  expect(await readFile(from, 'utf8')).toBe('move me\n');
});

test('file_patch moves without hunks with a matching baseHash', async () => {
  const from = join(root, 'patch-move-from.txt');
  const to = join(root, 'patch-move-to.txt');
  const content = 'move me\n';
  await writeFile(from, content);
  const out = await filePatchTool.run(
    {
      baseHashByPath: { [from]: sha256(content) },
      patch: `*** Begin Patch
*** Update File: ${from}
*** Move to: ${to}
*** End Patch`
    },
    ctx([root])
  );
  expect(out.metadata.files[0]).toMatchObject({ operation: 'move' });
  expect(out.metadata.files[0]?.path.endsWith('/patch-move-from.txt')).toBe(true);
  expect(out.metadata.files[0]?.newPath?.endsWith('/patch-move-to.txt')).toBe(true);
  expect(await readFile(to, 'utf8')).toBe('move me\n');
});

test('file_patch reports baseHashByPath mismatch with canonical path and hashes', async () => {
  const p = join(root, 'patch-delete-hash-mismatch.txt');
  await writeFile(p, 'delete me\n');
  const out = await filePatchTool.run(
    {
      baseHashByPath: { [p]: sha256('stale') },
      patch: `*** Begin Patch
*** Delete File: ${p}
*** End Patch`
    },
    ctx([root])
  );
  expect(out.metadata.files[0]).toMatchObject({
    status: 'error',
    error: expect.stringMatching(
      new RegExp(
        `baseHashByPath\\["${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\] does not match current file for .+patch-delete-hash-mismatch\\.txt\\. expected=${sha256('stale')} current=${sha256('delete me\n')}`
      )
    )
  });
});

test('file_patch moves without hunks with a persisted session observation', async () => {
  const from = join(root, 'patch-move-observed-from.txt');
  const to = join(root, 'patch-move-observed-to.txt');
  const sessionId = `s${++sessionCounter}`;
  await writeFile(from, 'move me\n');
  await fileReadTool.run({ path: from }, ctx([root], undefined, sessionId));
  const out = await filePatchTool.run(
    {
      patch: `*** Begin Patch
*** Update File: ${from}
*** Move to: ${to}
*** End Patch`
    },
    ctx([root], undefined, sessionId)
  );
  expect(out.metadata.files[0]).toMatchObject({ operation: 'move' });
  expect(await readFile(to, 'utf8')).toBe('move me\n');
});

test('file_patch serializes operations that target a move destination', async () => {
  const files = new Map([['/source.txt', 'a\n']]);
  const writes: string[] = [];
  const backends: ToolBackends = {
    fs: {
      delegated: true,
      async readTextFile(path) {
        const text = files.get(path);
        if (text === undefined) throw new Error('not found');
        return text;
      },
      async writeTextFile(path, content) {
        writes.push(path);
        files.set(path, content);
        return { path, bytesWritten: content.length };
      },
      async moveFile(from, to) {
        const text = files.get(from);
        if (text === undefined) throw new Error('not found');
        files.delete(from);
        files.set(to, text);
        return { path: from, newPath: to };
      }
    },
    terminal: {
      delegated: true,
      async exec() {
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
      }
    }
  };
  const out = await filePatchTool.run(
    {
      baseHashByPath: { '/source.txt': sha256('a\n') },
      patch: `*** Begin Patch
*** Update File: /source.txt
*** Move to: /dest.txt
*** Update File: /dest.txt
@@
-a
+b
*** End Patch`
    },
    { ...ctx(undefined), backends }
  );
  expect(out.metadata).toMatchObject({ succeeded: 2, failed: 0, changed: true });
  expect(writes).toEqual(['/source.txt', '/dest.txt']);
  expect(files.get('/dest.txt')).toBe('b\n');
});

test('file_patch reports context mismatches as file errors', async () => {
  const p = join(root, 'patch-context.txt');
  await writeFile(p, 'actual\n');
  const out = await filePatchTool.run(
    {
      patch: `*** Begin Patch
*** Update File: ${p}
@@
-expected
+after
*** End Patch`
    },
    ctx([root])
  );
  expect(out.metadata).toMatchObject({ succeeded: 0, failed: 1, changed: false });
  expect(out.metadata.files[0]).toMatchObject({
    status: 'error',
    error: `patch context did not match ${p} at hunk 1`
  });
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
  expect(res.files[0]).toMatchObject({ status: 'ok', bytesWritten: 8 });
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
  const file = res.files[0];
  if (file?.status !== 'ok') throw new Error('expected file_patch mutation');
  expect(file.summary).toMatchObject({ added: 1, removed: 1, changed: true });
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
