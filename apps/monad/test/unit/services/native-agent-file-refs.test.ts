import type { MessageAttachmentRef } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NATIVE_AGENT_ATTACHMENTS_MAX } from '@monad/protocol';

import { createNativeAgentAttachmentResolver } from '#/services/native-agent/attachments.ts';
import { parseNativeAgentFileReferences } from '#/services/native-agent/file-refs.ts';

test('parseNativeAgentFileReferences extracts @file markers and removes them from visible text', () => {
  const parsed = parseNativeAgentFileReferences(
    [
      'Implemented the parser.',
      '',
      '@file(apps/monad/src/services/native-agent/file-refs.ts)',
      '@file "./apps/monad/test/unit/services/native-agent-file-refs.test.ts"',
      '@file apps/monad/src/services/native-agent/file-refs.ts'
    ].join('\n')
  );

  expect(parsed.paths).toEqual([
    'apps/monad/src/services/native-agent/file-refs.ts',
    './apps/monad/test/unit/services/native-agent-file-refs.test.ts'
  ]);
  expect(parsed.text).toBe('Implemented the parser.');
});

test('parseNativeAgentFileReferences leaves ordinary @file prose alone', () => {
  const parsed = parseNativeAgentFileReferences('Please do not treat @filename or @file as an attachment.');

  expect(parsed.text).toBe('Please do not treat @filename or @file as an attachment.');
});

test('parseNativeAgentFileReferences extracts monad:file markdown links without changing visible text', () => {
  const text = [
    'Summary is ready: [report.md](./reports/report.md "monad:file").',
    'Relevant code: [auth.ts:12](./src/auth.ts#L12 "monad:file").',
    'Ordinary link: [docs](./docs/README.md).'
  ].join('\n');

  const parsed = parseNativeAgentFileReferences(text);

  expect(parsed.paths).toEqual(['./reports/report.md', './src/auth.ts']);
  expect(parsed.text).toBe(text);
});

test('parseNativeAgentFileReferences accepts file URLs for monad:file markdown links', () => {
  const parsed = parseNativeAgentFileReferences('[report.md](file:///tmp/report.md "monad:file")');

  expect(parsed.paths).toEqual(['/tmp/report.md']);
  expect(parsed.text).toBe('[report.md](file:///tmp/report.md "monad:file")');
});

test('parseNativeAgentFileReferences ignores file references inside markdown code', () => {
  const text = [
    'Use `[example.md](./example.md "monad:file")` when documenting the protocol.',
    '',
    '```md',
    '[report.md](./report.md "monad:file")',
    '@file(legacy-example.md)',
    '```',
    '',
    'Real attachment: [actual.md](./actual.md "monad:file").'
  ].join('\n');

  const parsed = parseNativeAgentFileReferences(text);

  expect(parsed.paths).toEqual(['./actual.md']);
  expect(parsed.text).toBe(text);
});

test('createNativeAgentAttachmentResolver registers @file references as message attachments', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'monad-file-ref-'));
  const report = join(workspace, 'report.md');
  await writeFile(report, '# Report\n\nDone.\n');
  const reportRealpath = await realpath(report);
  const registered: Array<Record<string, unknown>> = [];
  const resolver = createNativeAgentAttachmentResolver({
    registerMessageAttachments(atts: readonly Record<string, unknown>[]): MessageAttachmentRef[] {
      registered.push(...atts);
      return atts.map((att) => ({
        id: att.id as MessageAttachmentRef['id'],
        path: att.path as string,
        name: att.name as string,
        mime: att.mime as string,
        bytes: att.bytes as number,
        createdAt: att.createdAt as string
      }));
    }
  } as unknown as Parameters<typeof createNativeAgentAttachmentResolver>[0]);

  const result = await resolver(
    { text: `Summary is ready.\n@file(${report})` },
    { sessionId: 'ses_TEST', agentId: 'external-agent:test' },
    [workspace]
  );

  expect(result.text).toBe('Summary is ready.');
  expect(result.attachments).toHaveLength(1);
  expect(result.attachments[0]?.path).toBe(reportRealpath);
});

test('createNativeAgentAttachmentResolver registers monad:file markdown links as message attachments', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'monad-file-ref-md-'));
  const report = join(workspace, 'report with spaces.md');
  await writeFile(report, '# Report\n\nDone.\n');
  const reportRealpath = await realpath(report);
  const registered: Array<Record<string, unknown>> = [];
  const resolver = createNativeAgentAttachmentResolver({
    registerMessageAttachments(atts: readonly Record<string, unknown>[]): MessageAttachmentRef[] {
      registered.push(...atts);
      return atts.map((att) => ({
        id: att.id as MessageAttachmentRef['id'],
        path: att.path as string,
        name: att.name as string,
        mime: att.mime as string,
        bytes: att.bytes as number,
        createdAt: att.createdAt as string
      }));
    }
  } as unknown as Parameters<typeof createNativeAgentAttachmentResolver>[0]);
  const url = pathToFileURL(report).href;

  const result = await resolver(
    { text: `Summary is ready: [report with spaces.md](${url} "monad:file").` },
    { sessionId: 'ses_TEST', agentId: 'external-agent:test' },
    [workspace]
  );

  expect(result.text).toBe(`Summary is ready: [report with spaces.md](${url} "monad:file").`);
  expect(result.attachments).toHaveLength(1);
  expect(result.attachments[0]?.path).toBe(reportRealpath);
});

test('createNativeAgentAttachmentResolver applies the attachment limit after parsing @file references', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'monad-file-ref-limit-'));
  const resolver = createNativeAgentAttachmentResolver({
    registerMessageAttachments(): MessageAttachmentRef[] {
      throw new Error('should not register over-limit attachments');
    }
  } as unknown as Parameters<typeof createNativeAgentAttachmentResolver>[0]);
  const markers = Array.from({ length: NATIVE_AGENT_ATTACHMENTS_MAX + 1 }, (_, index) => `@file(file-${index}.txt)`);

  await expect(
    resolver({ text: markers.join('\n') }, { sessionId: 'ses_TEST', agentId: 'external-agent:test' }, [workspace])
  ).rejects.toThrow(`at most ${NATIVE_AGENT_ATTACHMENTS_MAX} file attachments per message`);
});
