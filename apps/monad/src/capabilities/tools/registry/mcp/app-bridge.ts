import type { McpAppView, McpAppViewResponse } from '@monad/protocol';

const BRIDGE_TTL_MS = 30 * 60_000;
const CAPABILITY_TTL_MS = 10 * 60_000;
const MAX_BRIDGES = 256;
const MAX_CAPABILITIES = 512;
const MAX_CALLS_PER_BRIDGE = 64;
const MAX_RESPONSE_BYTES = 6 * 1024 * 1024;
const MAX_VIEW_WAITERS = 256;
const MAX_VIEW_WAITERS_PER_BRIDGE = 8;
const VIEW_WAIT_MS = 25_000;

export type McpAppRpcRequest =
  | { method: 'tools/call'; params: { name: string; arguments?: Record<string, unknown> } }
  | { method: 'resources/read'; params: { uri: string } };

interface McpAppBridge {
  expiresAt: number;
  readResource(uri: string, signal?: AbortSignal): Promise<unknown>;
  resourceUri: string;
  server: string;
  sessionId: string;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  readView(): McpAppView | undefined;
}

interface McpAppCapability {
  bridgeId: string;
  calls: number;
  expiresAt: number;
}

export class McpAppBridgeError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 410 | 413 | 429
  ) {
    super(message);
    this.name = 'McpAppBridgeError';
  }
}

const bridges = new Map<string, McpAppBridge>();
const capabilities = new Map<string, McpAppCapability>();
const viewWaiters = new Map<string, Set<() => void>>();
let bridgeEvictions = 0;
let capabilityRevocations = 0;
let viewWaiterCount = 0;

export function registerMcpAppBridge(input: Omit<McpAppBridge, 'expiresAt'>): string {
  sweep();
  while (bridges.size >= MAX_BRIDGES) {
    const oldest = bridges.keys().next().value;
    if (typeof oldest !== 'string') break;
    bridgeEvictions += 1;
    revokeBridge(oldest);
  }
  const bridgeId = crypto.randomUUID();
  bridges.set(bridgeId, { ...input, expiresAt: Date.now() + BRIDGE_TTL_MS });
  return bridgeId;
}

export function issueMcpAppCapability(
  bridgeId: string,
  sessionId: string,
  revision?: string
): { token: string; expiresAt: string } {
  sweep();
  const bridge = bridges.get(bridgeId);
  if (!bridge) throw new McpAppBridgeError('MCP App bridge is unavailable', 404);
  if (bridge.sessionId !== sessionId) throw new McpAppBridgeError('MCP App bridge belongs to another session', 403);
  if (revision && bridge.readView()?.revision !== revision) {
    throw new McpAppBridgeError('MCP App view revision is stale', 410);
  }
  while (capabilities.size >= MAX_CAPABILITIES) {
    const oldest = capabilities.keys().next().value;
    if (typeof oldest !== 'string') break;
    capabilityRevocations += 1;
    capabilities.delete(oldest);
  }
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll('-', '');
  const expiresAt = Date.now() + CAPABILITY_TTL_MS;
  capabilities.set(token, { bridgeId, calls: 0, expiresAt });
  return { token, expiresAt: new Date(expiresAt).toISOString() };
}

export async function invokeMcpAppBridge(
  token: string,
  request: McpAppRpcRequest,
  signal?: AbortSignal
): Promise<unknown> {
  const capability = capabilities.get(token);
  if (!capability) throw new McpAppBridgeError('MCP App capability is invalid', 404);
  if (capability.expiresAt <= Date.now()) {
    capabilities.delete(token);
    throw new McpAppBridgeError('MCP App capability expired', 410);
  }
  const bridge = bridges.get(capability.bridgeId);
  if (!bridge || bridge.expiresAt <= Date.now()) {
    revokeBridge(capability.bridgeId);
    throw new McpAppBridgeError('MCP App bridge is unavailable', 410);
  }
  if (capability.calls >= MAX_CALLS_PER_BRIDGE) throw new McpAppBridgeError('MCP App call limit exceeded', 429);
  capability.calls += 1;
  const result =
    request.method === 'resources/read'
      ? request.params.uri === bridge.resourceUri
        ? await bridge.readResource(request.params.uri, signal)
        : (() => {
            throw new McpAppBridgeError('MCP App resource is outside this capability', 403);
          })()
      : await bridge.callTool(request.params.name, request.params.arguments ?? {}, signal);
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(result);
  } catch {
    throw new McpAppBridgeError('MCP App response is not JSON serializable', 413);
  }
  if (serialized === undefined || Buffer.byteLength(serialized) > MAX_RESPONSE_BYTES) {
    throw new McpAppBridgeError('MCP App response exceeds the safe output limit', 413);
  }
  return result;
}

export function revokeMcpAppCapability(token: string): boolean {
  const revoked = capabilities.delete(token);
  if (revoked) capabilityRevocations += 1;
  return revoked;
}

export function mcpAppBridgeMetrics(): {
  activeBridges: number;
  activeCapabilities: number;
  activeViewWaiters: number;
  bridgeEvictions: number;
  capabilityRevocations: number;
} {
  sweep();
  return {
    activeBridges: bridges.size,
    activeCapabilities: capabilities.size,
    activeViewWaiters: viewWaiterCount,
    bridgeEvictions,
    capabilityRevocations
  };
}

export async function waitForMcpAppView(
  bridgeId: string,
  sessionId: string,
  afterRevision: string | undefined,
  signal?: AbortSignal
): Promise<McpAppViewResponse> {
  const bridge = ownedBridge(bridgeId, sessionId);
  let view = bridge.readView();
  if (!view) throw new McpAppBridgeError('MCP App view is unavailable', 410);
  if (afterRevision === view.revision) {
    await waitForViewChange(bridgeId, signal);
    const current = ownedBridge(bridgeId, sessionId);
    view = current.readView();
    if (!view || view.revision === afterRevision) return { changed: false };
  }
  return { changed: true, view };
}

export function notifyMcpAppViewChanged(server: string, resourceUri: string): void {
  for (const [bridgeId, bridge] of bridges) {
    if (bridge.server !== server || bridge.resourceUri !== resourceUri) continue;
    revokeCapabilitiesForBridge(bridgeId);
    for (const notify of viewWaiters.get(bridgeId) ?? []) notify();
  }
}

export function revokeMcpAppBridgesForServer(server: string): void {
  for (const [bridgeId, bridge] of bridges) {
    if (bridge.server === server) revokeBridge(bridgeId);
  }
}

function sweep(): void {
  const now = Date.now();
  for (const [bridgeId, bridge] of bridges) {
    if (bridge.expiresAt <= now) revokeBridge(bridgeId);
  }
  for (const [token, capability] of capabilities) {
    if (capability.expiresAt <= now || !bridges.has(capability.bridgeId)) capabilities.delete(token);
  }
}

function revokeBridge(bridgeId: string): void {
  bridges.delete(bridgeId);
  for (const notify of viewWaiters.get(bridgeId) ?? []) notify();
  viewWaiters.delete(bridgeId);
  revokeCapabilitiesForBridge(bridgeId);
}

function revokeCapabilitiesForBridge(bridgeId: string): void {
  for (const [token, capability] of capabilities) {
    if (capability.bridgeId === bridgeId) {
      capabilities.delete(token);
      capabilityRevocations += 1;
    }
  }
}

function ownedBridge(bridgeId: string, sessionId: string): McpAppBridge {
  sweep();
  const bridge = bridges.get(bridgeId);
  if (!bridge) throw new McpAppBridgeError('MCP App bridge is unavailable', 404);
  if (bridge.sessionId !== sessionId) throw new McpAppBridgeError('MCP App bridge belongs to another session', 403);
  return bridge;
}

function waitForViewChange(bridgeId: string, signal?: AbortSignal): Promise<void> {
  const existing = viewWaiters.get(bridgeId)?.size ?? 0;
  if (viewWaiterCount >= MAX_VIEW_WAITERS || existing >= MAX_VIEW_WAITERS_PER_BRIDGE) {
    throw new McpAppBridgeError('MCP App view waiter limit exceeded', 429);
  }
  return new Promise((resolve) => {
    const waiters = viewWaiters.get(bridgeId) ?? new Set<() => void>();
    viewWaiters.set(bridgeId, waiters);
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      waiters.delete(finish);
      viewWaiterCount -= 1;
      if (!waiters.size) viewWaiters.delete(bridgeId);
      resolve();
    };
    timer = setTimeout(finish, VIEW_WAIT_MS);
    signal?.addEventListener('abort', finish, { once: true });
    waiters.add(finish);
    viewWaiterCount += 1;
  });
}
