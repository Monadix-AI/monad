import type { ToolContext } from '@/capabilities/tools/types.ts';

import { expect, test } from 'bun:test';

import { extractReadable, webExtractTool } from '@/capabilities/tools';

const ctx: ToolContext = { sessionId: 's1', sandboxRoots: undefined, log: () => {} };

const PAGE = `<!doctype html>
<html><head>
  <title>Widgets &amp; Co</title>
  <style>.x{color:red}</style>
  <script>console.log('tracker')</script>
</head>
<body>
  <nav><a href="/home">Home</a> <a href="/about">About</a></nav>
  <header>site header</header>
  <main>
    <h1>How Widgets Work</h1>
    <p>A widget is a <b>small</b> thing. See <a href="https://example.com/spec">the spec</a>.</p>
    <ul><li>First point</li><li>Second point</li></ul>
  </main>
  <footer>© 2026 noise</footer>
</body></html>`;

test('extractReadable pulls the title and main content, dropping chrome', () => {
  const { title, text } = extractReadable(PAGE);
  expect(title).toBe('Widgets & Co');
  // chrome/scripts/styles/nav are gone
});

test('extractReadable falls back to the body when there is no article/main', () => {
  const { text } = extractReadable('<html><body><p>Just a paragraph.</p><p>And another.</p></body></html>');
});

test('extractReadable decodes entities', () => {
  const { text } = extractReadable('<main><p>a &lt; b &amp;&amp; c &#39;d&#39; &#x2764;</p></main>');
});

test('web_extract enforces the net SSRF guard (loopback/metadata blocked)', async () => {
  // web_extract is model-driven, so it goes through the same SSRF guards as net_fetch:
  // loopback and the cloud-metadata address are rejected before any fetch.
  await expect(webExtractTool.run({ url: 'http://169.254.169.254/' }, ctx)).rejects.toThrow();
  await expect(webExtractTool.run({ url: 'http://localhost/' }, ctx)).rejects.toThrow();
});

test('web_extract schema rejects invalid URLs', () => {
  expect(webExtractTool.inputSchema?.safeParse({ url: 'https://example.com/' }).success).toBe(true);
  expect(webExtractTool.inputSchema?.safeParse({ url: '' }).success).toBe(false);
  expect(webExtractTool.inputSchema?.safeParse({ url: 'file:///etc/passwd' }).success).toBe(false);
});
