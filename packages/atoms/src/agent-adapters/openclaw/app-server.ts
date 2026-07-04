import type { AppServerProtocol } from '../app-server-jsonrpc.ts';

import { makeAppServerProtocol } from '../app-server-jsonrpc.ts';

// OpenClaw's local gateway (`openclaw gateway`) speaks JSON-RPC over WebSocket. It shares the
// `session.*` / `agent.*` / `approval.*` vocabulary with Hermes; only the turn method + its text
// field and the reconnect/error prose differ, so it is built from the shared factory.
export const openClawAppServerProtocol: AppServerProtocol = makeAppServerProtocol({
  provider: 'openclaw',
  messageMethod: 'agent.message',
  messageField: 'text',
  reconnectReason: 'OpenClaw requires reconnect',
  errorReason: 'OpenClaw provider error'
});
