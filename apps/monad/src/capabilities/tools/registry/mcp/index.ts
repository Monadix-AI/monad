// MCP client bridge. Remote tools are highRisk by default: they cross a trust boundary
// and the daemon can't reason about their side effects, so a human approves each call.
//
// Two transports behind one RpcChannel abstraction so the handshake and tool wrapping
// are shared. Implemented directly rather than via the SDK — fewer deps, routes through
// monad's patterns. (OAuth discovery for http is a later phase; static headers are wired here.)

import type { Tool, ToolInputSchema, ToolResultPart } from '../../types.ts';

import { createLogger } from '@monad/logger';
import { z } from 'zod';

import { daemonChildProcesses } from '#/infra/daemon-child-processes.ts';
import { daemonTrackedProcessTreeSpawnOptions, supervisedSpawn } from '#/infra/spawn-supervisor.ts';
import { toolResult } from '../../types.ts';

const log = createLogger('mcp');
const PROTOCOL_VERSION = '2025-06-18';
// Soft ceiling on a single MCP result's text. An untrusted server can flood the model's context
// (cost amplification / context squeeze). We warn rather than block: truncating could break a
// legitimate large-but-honest result, so visibility is the right trade-off here.
const MCP_RESULT_WARN_BYTES = 256 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

// Providers require tool names to match ^[a-zA-Z0-9_-]{1,128}$. MCP server names and remote tool
// names are external/uncontrolled and may contain dots or other illegal characters, so the
// model-facing name is sanitized here at the boundary. The remote call still uses the original
// `rt.name` (captured in `run`), so dispatch to the server is unaffected.
function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
}

// The model-facing name monad gives a remote tool: `<server>__<tool>`, sanitized. SINGLE SOURCE
// OF TRUTH — anything that must refer to a remote tool by its monad name (config autoApproveTools
// presets, trust pinning, etc.) derives it here instead of hand-building the string, so the
// separator and sanitization can never drift apart (the `browser.` vs `browser__` bug class).
function mcpToolName(server: string, tool: string): string {
  return sanitizeToolName(`${server}__${tool}`);
}

// Canonical identity key for http MCP servers: trailing-slash-insensitive, case-insensitive
// scheme+host, default ports elided, path/query sensitive. Two packs declaring the same URL after
// normalization share a single connection — the first declarant wins.
function _normalizeMcpUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hostname = u.hostname.toLowerCase();
    if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) {
      u.port = '';
    }
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.protocol}//${u.host}${path}${u.search}`;
  } catch {
    return url.toLowerCase();
  }
}

interface McpStdioSpec {
  /** Namespaces exposed tools as `<name>__<remoteTool>`. */
  name: string;
  transport?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  requestTimeoutMs?: number;
}

/** A dynamic authorization source (e.g. OAuth) for an http MCP server. */
export interface McpHttpAuth {
  getHeader(): Promise<string | undefined>;
  /** Returns true if the request should retry after re-authorization. */
  onUnauthorized?(): Promise<boolean>;
}

/** `headers` carries static auth; `auth` adds a dynamic source (OAuth) that refreshes on 401. */
interface McpHttpSpec {
  name: string;
  transport: 'http';
  url: string;
  headers?: Record<string, string>;
  auth?: McpHttpAuth;
  requestTimeoutMs?: number;
}

export type McpServerSpec = McpStdioSpec | McpHttpSpec;

const jsonRpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.number().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }).optional()
});
type JsonRpcResponse = z.infer<typeof jsonRpcResponseSchema>;

interface RemoteToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** A live connection to an MCP server plus the monad Tools it exposes. */
export interface McpConnection {
  name: string;
  tools: Tool[];
  callTool(name: string, args: unknown): Promise<unknown>;
  close(): Promise<void>;
}

class McpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpError';
  }
}

// Remote schemas are JSON Schema; we don't ship a JSON-Schema validator, and the server
// validates anyway. This passthrough satisfies the ToolInputSchema contract without
// re-validating — the gate still sees the raw args.
const passthroughSchema: ToolInputSchema<Record<string, unknown>> = {
  safeParse: (input) =>
    input !== null && typeof input === 'object' && !Array.isArray(input)
      ? { success: true, data: input as Record<string, unknown> }
      : { success: false, error: new McpError('tool input must be an object') }
};

// A tool result's image bytes ride here rather than on an enumerable field: JSON.stringify
// (used by the agent loop for the model's text channel AND for the persisted event store)
// must never inline a megabyte of base64, but toModelOutput still needs the real bytes to feed
// the model a perceivable image. A Symbol key is invisible to JSON.stringify, so the text
// channel stays small while the vision channel gets the pixels. Mirrors how image_generate
// keeps bytes off the persisted result (it returns a path) and reads them back in toModelOutput.
const MCP_IMAGES = Symbol('mcpImages');

interface McpImage {
  image: Uint8Array;
  mediaType?: string;
}

/** Normalized MCP tool result: text on the model's text channel, image bytes off-channel. */
interface McpToolResult {
  text: string;
  imageCount: number;
}

function mcpImagesOf(output: unknown): McpImage[] {
  if (output && typeof output === 'object' && MCP_IMAGES in output) {
    return (output as Record<symbol, McpImage[]>)[MCP_IMAGES] ?? [];
  }
  return [];
}

// MCP tool results are an array of content blocks; images arrive base64-inline. Split them so
// text (and a count of any images) goes on the text channel while decoded image bytes are
// stashed under MCP_IMAGES for toModelOutput. Unrecognized block kinds are serialized into the
// text so nothing is silently dropped. A non-array result (some servers return a bare value) is
// JSON-dumped as text.
function normalizeMcpResult(raw: unknown): McpToolResult {
  if (!Array.isArray(raw)) {
    const result: McpToolResult = { text: typeof raw === 'string' ? raw : JSON.stringify(raw), imageCount: 0 };
    Object.defineProperty(result, MCP_IMAGES, { value: [] as McpImage[], enumerable: false });
    return result;
  }
  const texts: string[] = [];
  const images: McpImage[] = [];
  for (const b of raw) {
    if (!b || typeof b !== 'object') continue;
    const block = b as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
    } else if (block.type === 'image' && typeof block.data === 'string') {
      images.push({
        image: Uint8Array.from(Buffer.from(block.data, 'base64')),
        ...(typeof block.mimeType === 'string' ? { mediaType: block.mimeType } : {})
      });
    } else {
      texts.push(JSON.stringify(block));
    }
  }
  const text = texts.length ? texts.join('\n') : images.length ? `(returned ${images.length} image(s))` : '';
  if (text.length > MCP_RESULT_WARN_BYTES) {
    log.warn(
      { bytes: text.length, limit: MCP_RESULT_WARN_BYTES },
      'mcp result text exceeds soft limit (not truncated)'
    );
  }
  const result: McpToolResult = { text, imageCount: images.length };
  Object.defineProperty(result, MCP_IMAGES, { value: images, enumerable: false });
  return result;
}

// The model perceives an MCP result as its text plus any returned images. The loop pulls image
// parts from here and feeds them back as a follow-up turn; the text part is redundant with the
// persisted result but keeps this faithful to the toModelOutput contract.
function mcpToModelOutput(output: McpToolResult): ToolResultPart[] {
  const parts: ToolResultPart[] = [];
  if (output.text) parts.push({ type: 'text', text: output.text });
  for (const img of mcpImagesOf(output)) {
    parts.push({ type: 'image', image: img.image, ...(img.mediaType ? { mediaType: img.mediaType } : {}) });
  }
  return parts;
}

/** A bidirectional JSON-RPC channel to an MCP server. */
interface RpcChannel {
  request(method: string, params?: unknown): Promise<unknown>;
  /** Send a notification (no id, no response expected). */
  notify(method: string, params?: unknown): Promise<void>;
  close(): Promise<void>;
}

function createStdioChannel(spec: McpStdioSpec): RpcChannel {
  const timeoutMs = spec.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const proc = supervisedSpawn(
    [spec.command, ...(spec.args ?? [])],
    {
      cwd: spec.cwd,
      // Inherit the daemon env and layer spec.env on top — a trimmed env breaks node/npx
      // resolution and Windows processes that need SystemRoot/PATHEXT.
      env: { ...Bun.env, ...spec.env },
      detached: true,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe'
    },
    {
      ...daemonTrackedProcessTreeSpawnOptions({
        event: 'mcp.stdio_spawn',
        log,
        context: { serverName: spec.name },
        trackLabel: 'mcp:stdio',
        tracker: daemonChildProcesses
      })
    }
  );

  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  // Background reader: notifications (no numeric id) are silently ignored.
  (async () => {
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let parsed: ReturnType<typeof jsonRpcResponseSchema.safeParse>;
        try {
          parsed = jsonRpcResponseSchema.safeParse(JSON.parse(line));
        } catch {
          continue;
        }
        if (!parsed.success || typeof parsed.data.id !== 'number') continue;
        const res = parsed.data;
        const numericId = res.id as number;
        const waiter = pending.get(numericId);
        if (waiter) {
          clearTimeout(waiter.timer);
          pending.delete(numericId);
          waiter.resolve(res);
        }
      }
    }
    for (const [, w] of pending) {
      clearTimeout(w.timer);
      w.reject(new McpError('MCP server stdout closed'));
    }
    pending.clear();
  })();

  function write(msg: unknown): void {
    proc.stdin.write(`${JSON.stringify(msg)}\n`);
    proc.stdin.flush();
  }

  function rawRequest(method: string, params?: unknown): Promise<JsonRpcResponse> {
    const id = nextId++;
    write({ jsonrpc: '2.0', id, method, params });
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new McpError(`MCP request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
    });
  }

  return {
    async request(method, params) {
      const res = await rawRequest(method, params);
      if (res.error) throw new McpError(`MCP ${method} failed: ${res.error.message}`);
      return res.result;
    },
    async notify(method, params) {
      write({ jsonrpc: '2.0', method, params });
    },
    async close() {
      for (const [, w] of pending) {
        clearTimeout(w.timer);
        w.reject(new McpError('connection closed'));
      }
      pending.clear();
      proc.supervision.stop('manual', 'SIGTERM');
      await proc.exited;
    }
  };
}

async function readSseResponse(res: Response, id: number): Promise<JsonRpcResponse> {
  if (!res.body) throw new McpError('MCP HTTP response had no body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep = buf.indexOf('\n\n');
      while (sep !== -1) {
        const event = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const data = event
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n');
        if (data) {
          try {
            const r = jsonRpcResponseSchema.safeParse(JSON.parse(data));
            if (r.success && r.data.id === id) return r.data;
          } catch {
            // partial / non-JSON event
          }
        }
        sep = buf.indexOf('\n\n');
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  throw new McpError('MCP HTTP SSE stream ended without a matching response');
}

function createHttpChannel(spec: McpHttpSpec): RpcChannel {
  const timeoutMs = spec.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let sessionId: string | undefined;
  let nextId = 1;

  async function post(body: unknown, expectResponse: boolean, retried = false): Promise<JsonRpcResponse | null> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL_VERSION,
      ...spec.headers
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    // OAuth header overrides any static Authorization header.
    const dynamic = spec.auth ? await spec.auth.getHeader() : undefined;
    if (dynamic) headers.authorization = dynamic;

    const res = await fetch(spec.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;

    if (res.status === 401) {
      // One retry after re-authorization; avoid an infinite loop.
      if (!retried && spec.auth?.onUnauthorized) {
        await res.body?.cancel().catch(() => {});
        if (await spec.auth.onUnauthorized()) return post(body, expectResponse, true);
      }
      throw new McpError(`MCP HTTP server returned 401 Unauthorized — check auth for ${spec.url}`);
    }
    if (!res.ok && res.status !== 202) {
      throw new McpError(`MCP HTTP server returned ${res.status} ${res.statusText} for ${spec.url}`);
    }
    if (!expectResponse || res.status === 202) {
      await res.body?.cancel().catch(() => {});
      return null;
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      return readSseResponse(res, (body as { id: number }).id);
    }
    return jsonRpcResponseSchema.parse(await res.json());
  }

  return {
    async request(method, params) {
      const id = nextId++;
      const res = await post({ jsonrpc: '2.0', id, method, params }, true);
      if (!res) throw new McpError(`MCP ${method} returned no response`);
      if (res.error) throw new McpError(`MCP ${method} failed: ${res.error.message}`);
      return res.result;
    },
    async notify(method, params) {
      await post({ jsonrpc: '2.0', method, params }, false);
    },
    async close() {
      // Stateless from the client side; nothing to tear down.
      // (A DELETE to end the session could be sent once servers require it.)
    }
  };
}

/**
 * Connect to an MCP server, perform the initialize handshake, list its tools, and wrap
 * each as a monad Tool. Callers should try/catch so one bad server never blocks the others.
 */
export async function connectMcpServer(spec: McpServerSpec): Promise<McpConnection> {
  const channel = spec.transport === 'http' ? createHttpChannel(spec) : createStdioChannel(spec);

  try {
    await channel.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'monad', version: '0.0.0' }
    });
    // `notifications/initialized` is required before any normal operations per the spec.
    await channel.notify('notifications/initialized', {});
    const listed = (await channel.request('tools/list', {})) as { tools?: RemoteToolDef[] };
    const remoteTools = listed.tools ?? [];

    log.debug({ server: spec.name, transport: spec.transport ?? 'stdio', tools: remoteTools.length }, 'mcp connected');

    const conn: McpConnection = {
      name: spec.name,
      tools: [],
      async callTool(name, args) {
        const t0 = Date.now();
        log.debug({ server: spec.name, tool: name }, `→ ${spec.name}/${name}`);
        let result: { content?: unknown; isError?: boolean };
        try {
          result = (await channel.request('tools/call', { name, arguments: args ?? {} })) as {
            content?: unknown;
            isError?: boolean;
          };
        } catch (err) {
          log.warn(
            {
              server: spec.name,
              tool: name,
              durationMs: Date.now() - t0,
              err: err instanceof Error ? err.message : String(err)
            },
            `← ${spec.name}/${name} error`
          );
          throw err;
        }
        if (result.isError) {
          log.warn({ server: spec.name, tool: name, durationMs: Date.now() - t0 }, `← ${spec.name}/${name} tool error`);
          throw new McpError(`MCP tool "${name}" reported an error: ${JSON.stringify(result.content)}`);
        }
        log.debug({ server: spec.name, tool: name, durationMs: Date.now() - t0 }, `← ${spec.name}/${name}`);
        return result.content ?? result;
      },
      close: () => channel.close()
    };

    conn.tools = remoteTools.map<Tool>((rt) => ({
      name: mcpToolName(spec.name, rt.name),
      description: rt.description ?? `MCP tool ${rt.name} from ${spec.name}`,
      scopes: [{ resource: `mcp:${spec.name}` }],
      highRisk: true, // external trust boundary
      inputSchema: passthroughSchema,
      run: async (input) => {
        const result = normalizeMcpResult(await conn.callTool(rt.name, input));
        return toolResult(result, { modelContent: mcpToModelOutput(result) });
      }
    }));

    return conn;
  } catch (err) {
    await channel.close().catch(() => {});
    throw err;
  }
}
