// web_extract — fetch a page and extract its main readable content as clean markdown-ish
// text. Zero-dep heuristic HTML→text pass (no jsdom). Reuses fetchTextSafe so the same
// SSRF guards (scheme check, DNS-rebind re-check, redirect re-validation) apply.

import type { Tool } from '../types.ts';

import { z } from 'zod';

import { toolResult } from '../types.ts';
import { fetchTextSafe } from './net.ts';

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCharCode(Number.parseInt(n, 16)));
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function removeBlock(html: string, tag: string): string {
  return html.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), ' ');
}

/**
 * Heuristic, not a full DOM parse: drop non-content blocks, prefer <article>/<main>,
 * convert headings/links/lists to markdown, flatten the rest.
 */
export function extractReadable(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripTags(titleMatch[1] ?? '') : '';

  let body = html.replace(/<!--[\s\S]*?-->/g, ' ');
  for (const tag of ['script', 'style', 'noscript', 'svg', 'head', 'nav', 'header', 'footer', 'aside', 'form']) {
    body = removeBlock(body, tag);
  }

  const region = body.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ?? body.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  let content = region ? (region[1] ?? '') : body;

  content = content.replace(
    /<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, inner: string) => `[${stripTags(inner)}](${href})`
  );
  content = content.replace(
    /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_m, level: string, inner: string) => `\n\n${'#'.repeat(Number(level))} ${stripTags(inner)}\n\n`
  );
  content = content.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => `\n- ${stripTags(inner)}`);
  content = content.replace(/<\/(p|div|section|tr|ul|ol|blockquote)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n');

  const text = decodeEntities(content.replace(/<[^>]+>/g, ''))
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title, text };
}

const webExtractInput = z.object({
  url: z.string().min(1),
  maxBytes: z.number().int().min(1).optional()
});

export const webExtractTool: Tool<
  z.infer<typeof webExtractInput>,
  { url: string; title: string; text: string; truncated: boolean }
> = {
  name: 'web_extract',
  description:
    'Fetch a web page and return its main readable content as clean text (with links), stripped of HTML chrome. Use instead of net_fetch when you want the article, not the markup.',
  scopes: [{ resource: 'net:fetch' }],
  inputSchema: webExtractInput,
  run: async ({ url, maxBytes }) => {
    const res = await fetchTextSafe(url, { maxBytes });
    const contentType = res.headers['content-type'] ?? '';
    if (!contentType.includes('html')) {
      return toolResult({ url: res.url, title: '', text: res.body.trim(), truncated: res.truncated });
    }
    const { title, text } = extractReadable(res.body);
    return toolResult({ url: res.url, title, text, truncated: res.truncated });
  }
};

const webExtractTools: Tool[] = [webExtractTool as Tool];

import type { ToolModule } from './contract.ts';
// Uniform module entry. Static module — no boot deps.
export const register: ToolModule = () => webExtractTools;
