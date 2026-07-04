import type { AppServerProtocol } from '../app-server-jsonrpc.ts';

import { makeAppServerProtocol } from '../app-server-jsonrpc.ts';

// Hermes's backend (`hermes serve`) speaks JSON-RPC over WebSocket. It shares the `session.*` /
// `agent.*` / `approval.*` vocabulary with OpenClaw; only the turn method + its text field and the
// reconnect/error prose differ, so it is built from the shared factory.
export const hermesAppServerProtocol: AppServerProtocol = makeAppServerProtocol({
  provider: 'hermes',
  messageMethod: 'agent.chat',
  messageField: 'prompt',
  reconnectReason: 'Hermes requires reconnect',
  errorReason: 'Hermes provider error'
});
