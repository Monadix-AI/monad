import type { MessageAttachmentRef } from '@monad/protocol';

import { expect, test } from 'bun:test';

import {
  inferPreviewLanguage,
  renderedFilePreviewKind,
  sandboxedHtml
} from '../../src/workplace-experiences/chat-room/components/file-preview-panel.tsx';

test('file preview infers syntax languages from filenames', () => {
  expect([
    inferPreviewLanguage('/workspace/report.ts'),
    inferPreviewLanguage('/workspace/config.yaml'),
    inferPreviewLanguage('/workspace/README.unknown')
  ]).toEqual(['typescript', 'yaml', 'text']);
});

test('HTML and Markdown attachments expose rendered view modes by MIME or extension', () => {
  const attachment = (path: string, mime: string): MessageAttachmentRef => ({
    id: 'att_100000000000',
    path,
    name: path.split('/').at(-1) ?? path,
    mime,
    bytes: 20,
    createdAt: '2026-08-11T00:00:00.000Z'
  });
  expect([
    renderedFilePreviewKind(attachment('/workspace/page.html', 'text/plain')),
    renderedFilePreviewKind(attachment('/workspace/README', 'text/markdown; charset=utf-8')),
    renderedFilePreviewKind(attachment('/workspace/data.json', 'application/json'))
  ]).toEqual(['html', 'markdown', null]);
});

test('rendered HTML injects a network-blocking content security policy into the document head', () => {
  expect(sandboxedHtml('<html><head><title>Report</title></head><body>Ready</body></html>')).toContain(
    `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline';">`
  );
});

test('rendered HTML places the security policy before adversarial head markup', () => {
  const content = '<!-- <head> --><img src="https://remote.example/ping">';
  const rendered = sandboxedHtml(content);

  expect({
    contentPreserved: rendered.includes(content),
    policyBeforeContent: rendered.indexOf('Content-Security-Policy') < rendered.indexOf(content)
  }).toEqual({ contentPreserved: true, policyBeforeContent: true });
});
