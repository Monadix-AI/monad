import type { CallToolResult, ContentBlock } from '@modelcontextprotocol/client';
import type { ToolResultPart } from '../../types.ts';

import { createLogger } from '@monad/logger';

const log = createLogger('mcp');
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_STRUCTURED_BYTES = 512 * 1024;
const MAX_CONTENT_BLOCKS = 128;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MCP_IMAGES = Symbol('mcpImages');

interface McpImage {
  image: Uint8Array;
  mediaType?: string;
}

export interface McpToolResult {
  text: string;
  imageCount: number;
  structuredContent?: unknown;
  taskId?: string;
  truncated: boolean;
}

function imagesOf(output: unknown): McpImage[] {
  if (output && typeof output === 'object' && MCP_IMAGES in output) {
    return (output as Record<symbol, McpImage[]>)[MCP_IMAGES] ?? [];
  }
  return [];
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoded = Buffer.from(value);
  if (encoded.byteLength <= maxBytes) return { text: value, truncated: false };
  return {
    text: `${encoded.subarray(0, maxBytes).toString('utf8')}\n[MCP result truncated at ${maxBytes} bytes]`,
    truncated: true
  };
}

export function normalizeMcpResult(raw: CallToolResult): McpToolResult {
  const texts: string[] = [];
  const images: McpImage[] = [];
  let truncated = raw.content.length > MAX_CONTENT_BLOCKS;
  for (const content of raw.content.slice(0, MAX_CONTENT_BLOCKS)) {
    const block = content as ContentBlock & Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    else if (block.type === 'image' && typeof block.data === 'string') {
      const estimatedBytes = Math.ceil((block.data.length * 3) / 4);
      if (images.length >= MAX_IMAGES || estimatedBytes > MAX_IMAGE_BYTES) truncated = true;
      else
        images.push({
          image: Uint8Array.from(Buffer.from(block.data, 'base64')),
          ...(typeof block.mimeType === 'string' ? { mediaType: block.mimeType } : {})
        });
    } else texts.push(JSON.stringify(block));
  }
  let structuredContent: unknown;
  if (raw.structuredContent !== undefined) {
    const serialized = JSON.stringify(raw.structuredContent);
    if (Buffer.byteLength(serialized) <= MAX_STRUCTURED_BYTES) {
      structuredContent = raw.structuredContent;
      texts.push(serialized);
    } else {
      texts.push(truncateUtf8(serialized, MAX_STRUCTURED_BYTES).text);
      truncated = true;
    }
  }
  const joined = texts.length ? texts.join('\n') : images.length ? `(returned ${images.length} image(s))` : '';
  const bounded = truncateUtf8(joined, MAX_TEXT_BYTES);
  truncated ||= bounded.truncated;
  if (truncated) log.warn({ blocks: raw.content.length }, 'mcp result exceeded bounded output limits');
  const result: McpToolResult = {
    text: bounded.text,
    imageCount: images.length,
    ...(structuredContent !== undefined ? { structuredContent } : {}),
    ...(typeof raw._meta?.['io.modelcontextprotocol/related-task'] === 'object' &&
    raw._meta?.['io.modelcontextprotocol/related-task'] !== null &&
    typeof (raw._meta['io.modelcontextprotocol/related-task'] as Record<string, unknown>).taskId === 'string'
      ? { taskId: (raw._meta['io.modelcontextprotocol/related-task'] as Record<string, unknown>).taskId as string }
      : {}),
    truncated
  };
  Object.defineProperty(result, MCP_IMAGES, { value: images, enumerable: false });
  return result;
}

export function mcpToModelOutput(output: McpToolResult): ToolResultPart[] {
  const parts: ToolResultPart[] = [];
  if (output.text) parts.push({ type: 'text', text: output.text });
  for (const image of imagesOf(output))
    parts.push({ type: 'image', image: image.image, ...(image.mediaType ? { mediaType: image.mediaType } : {}) });
  return parts;
}
