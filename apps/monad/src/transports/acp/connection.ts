// ACP transport — monad as an Agent Client Protocol agent over stdio.
//
// Unlike the native stdio dialect (transports/stdio.ts), ACP is a *bidirectional* JSON-RPC
// peer: the agent issues requests back to the client (permission, fs, terminal). We lean on
// the official SDK's agent() builder for the peer + id-correlation, and reuse the daemon's
// existing `handlers` + event flow — this file is a pure protocol adapter, no business logic.
//
// stdout is exclusively the ACP channel; all logs MUST go to stderr.

import type { AgentConnection, Stream } from '@agentclientprotocol/sdk';
import type { Handlers } from '#/transports/acp/types.ts';

import { agent as createAcpAgent, ndJsonStream } from '@agentclientprotocol/sdk';

import { MonadAcpAgent } from '#/transports/acp/agent.ts';

export type { AcpHandlers } from '#/transports/acp/types.ts';

export { toMcpSpec } from '#/transports/acp/meta.ts';

/** Bind monad's handlers to an ACP peer over an arbitrary message stream. Returns the live
 * connection. Used by {@link startAcpTransport} for stdio and by tests over an in-memory pipe.
 * `sandboxRoots` is the fallback boundary for sessions whose client can't take fs/terminal. */
export function connectAcp(handlers: Handlers, stream: Stream, sandboxRoots?: string[]): AgentConnection {
  // Each call to connectAcp creates a fresh MonadAcpAgent (via onConnect) that owns per-connection
  // state (sessions map, clientCaps, etc.). The closure variable `inst` is unique per call, so
  // multiple simultaneous connections (or sequential test runs) don't share state.
  let inst!: MonadAcpAgent;
  const asParams = (p: unknown) => p as Record<string, unknown>;
  return createAcpAgent({ name: 'monad' })
    .onConnect((conn) => {
      inst = new MonadAcpAgent(conn, handlers, sandboxRoots);
    })
    .onRequest('initialize', ({ params }) => inst.initialize(params))
    .onRequest('authenticate', ({ params }) => inst.authenticate(params))
    .onRequest('session/new', ({ params }) => inst.newSession(params))
    .onRequest('session/fork', ({ params }) => inst.unstable_forkSession(params))
    .onRequest('session/load', ({ params }) => inst.loadSession(params))
    .onRequest('session/resume', ({ params }) => inst.resumeSession(params))
    .onRequest('session/list', ({ params }) => inst.listSessions(params))
    .onRequest('session/delete', ({ params }) => inst.deleteSession(params))
    .onRequest('session/close', ({ params }) => inst.closeSession(params))
    .onRequest('session/prompt', ({ params }) => inst.prompt(params))
    .onNotification('session/cancel', ({ params }) => inst.cancel(params))
    .onNotification('document/didOpen', ({ params }) => inst.unstable_didOpenDocument(params))
    .onNotification('document/didChange', ({ params }) => inst.unstable_didChangeDocument(params))
    .onNotification('document/didClose', ({ params }) => inst.unstable_didCloseDocument(params))
    .onNotification('document/didFocus', ({ params }) => inst.unstable_didFocusDocument(params))
    .onNotification('document/didSave', ({ params }) => inst.unstable_didSaveDocument(params))
    .onRequest('_monad/session.restore', asParams, ({ params }) => inst.extMethod('_monad/session.restore', params))
    .onRequest('_monad/model.listProviders', asParams, ({ params }) =>
      inst.extMethod('_monad/model.listProviders', params)
    )
    .onRequest('_monad/model.listModels', asParams, ({ params }) => inst.extMethod('_monad/model.listModels', params))
    .onRequest('_monad/model.listProfiles', asParams, ({ params }) =>
      inst.extMethod('_monad/model.listProfiles', params)
    )
    .onRequest('_monad/model.getDefaultProfile', asParams, ({ params }) =>
      inst.extMethod('_monad/model.getDefaultProfile', params)
    )
    .onRequest('_monad/model.setDefaultProfile', asParams, ({ params }) =>
      inst.extMethod('_monad/model.setDefaultProfile', params)
    )
    .connect(stream);
}

/** Start the ACP transport on stdio. Resolves when the client disconnects (stdin EOF). */
export async function startAcpTransport(handlers: Handlers, sandboxRoots?: string[]): Promise<void> {
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        process.stdout.write(chunk, (err) => (err ? reject(err) : resolve()));
      });
    }
  });
  const stream = ndJsonStream(output, Bun.stdin.stream());
  const conn = connectAcp(handlers, stream, sandboxRoots);
  await conn.closed;
}
