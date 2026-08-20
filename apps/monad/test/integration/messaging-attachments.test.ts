import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  messageAttachmentPresentations,
  messageTextWithAttachments,
  persistMessageAttachmentPresentations
} from '#/handlers/session/handlers/messaging-attachments.ts';

test('message attachment presentations retain display metadata and discard inline payloads', () => {
  const attachments = messageAttachmentPresentations(
    [
      {
        kind: 'image',
        name: 'diagram.png',
        mediaType: 'image/png',
        size: 4321,
        dataBase64: 'sensitive-image-payload'
      },
      {
        kind: 'text',
        name: 'notes.md',
        mediaType: 'text/markdown',
        size: 42,
        text: 'sensitive inline notes'
      },
      { kind: 'file-meta', name: 'archive.zip', mediaType: 'application/zip', size: 9000 }
    ],
    {
      createdAt: '2026-07-19T00:00:00.000Z',
      newAttachmentId: (index) => `att_TEST0000000${index}` as `att_${string}`
    }
  );

  expect(attachments).toEqual([
    {
      id: 'att_TEST00000000',
      name: 'diagram.png',
      mime: 'image/png',
      bytes: 4321,
      createdAt: '2026-07-19T00:00:00.000Z'
    },
    {
      id: 'att_TEST00000001',
      name: 'notes.md',
      mime: 'text/markdown',
      bytes: 42,
      createdAt: '2026-07-19T00:00:00.000Z'
    },
    {
      id: 'att_TEST00000002',
      name: 'archive.zip',
      mime: 'application/zip',
      bytes: 9000,
      createdAt: '2026-07-19T00:00:00.000Z'
    }
  ]);
});

test('persisted message attachments retain reloadable image content', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'monad-message-attachments-'));
  const registered: Array<{ id: string; path: string }> = [];
  try {
    const attachments = await persistMessageAttachmentPresentations(
      [
        {
          kind: 'image',
          name: 'diagram.png',
          mediaType: 'image/png',
          size: 3,
          dataBase64: 'cG5n'
        }
      ],
      {
        workspaceDir: cacheDir,
        createdAt: '2026-07-28T00:00:00.000Z',
        newAttachmentId: () => 'att_TEST00000000',
        registerAttachments: (records) => {
          registered.push(...records);
          return records.map(({ id, path, name, mime, bytes, createdAt }) => ({
            id: id as `att_${string}`,
            path,
            name,
            mime,
            bytes,
            createdAt
          }));
        },
        sessionId: 'ses_TEST00000000'
      }
    );

    expect({
      attachments,
      content: await Bun.file(registered[0]?.path ?? '').text()
    }).toEqual({
      attachments: [
        {
          id: 'att_TEST00000000',
          name: 'diagram.png',
          mime: 'image/png',
          bytes: 3,
          createdAt: '2026-07-28T00:00:00.000Z',
          path: registered[0]?.path
        }
      ],
      content: 'png'
    });
  } finally {
    await rm(cacheDir, { force: true, recursive: true });
  }
});

test('uploaded binary files persist inside the agent workspace and provide an accessible prompt path', async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), 'monad-agent-workspace-'));
  const registered: Array<{ id: string; path: string }> = [];
  try {
    const source = [
      {
        kind: 'file' as const,
        name: '2.mp4',
        mediaType: 'video/mp4',
        size: 3,
        dataBase64: 'bXA0'
      }
    ];
    const attachments = await persistMessageAttachmentPresentations(source, {
      workspaceDir,
      createdAt: '2026-07-28T00:00:00.000Z',
      newAttachmentId: () => 'att_TEST00000001',
      registerAttachments: (records) => {
        registered.push(...records);
        return records.map(({ id, path, name, mime, bytes, createdAt }) => ({
          id: id as `att_${string}`,
          path,
          name,
          mime,
          bytes,
          createdAt
        }));
      },
      sessionId: 'ses_TEST00000000'
    });

    expect({
      content: await Bun.file(registered[0]?.path ?? '').text(),
      prompt: messageTextWithAttachments('Inspect this', source, attachments)
    }).toEqual({
      content: 'mp4',
      prompt: `Inspect this

<attachments>
Attachment 1: 2.mp4 (video/mp4, 3 bytes)
[uploaded file available at ${registered[0]?.path}]
</attachments>`
    });
  } finally {
    await rm(workspaceDir, { force: true, recursive: true });
  }
});
