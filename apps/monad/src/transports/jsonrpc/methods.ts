// JSON-RPC binding layer: maps each wire method to its DaemonHandlers invocation.
// The method set and params schemas are the wire contract (@monad/protocol's
// RPC_METHOD_PARAMS); this map is the app-side counterpart. The mapped type over
// `RpcMethod` makes the binding exhaustive — a new method fails to compile until
// it is bound here. Handlers receive already-parsed, schema-valid params.

import type {
  CreateSessionOriginHint,
  JsonRpcNotification,
  JsonRpcResponse,
  RpcMethod,
  RpcParams,
  RpcResult
} from '@monad/protocol';
import type { EventSink } from '@/handlers/session/index.ts';
import type { ConnectionState } from '@/transports/jsonrpc/connection.ts';

import { createDaemonHandlers } from '@/handlers/handlers.ts';
import { buildSessionOrigin } from '@/handlers/session/origin.ts';

export type Push = (msg: JsonRpcResponse | JsonRpcNotification) => void;

/** Build a full session origin for the native socket: tui surface, shared `http` write-class. */
const nativeOrigin = (origin?: CreateSessionOriginHint) =>
  buildSessionOrigin({
    transport: 'http',
    surface: origin?.surface ?? 'tui',
    client: origin?.client ?? 'monad-cli',
    clientVersion: origin?.clientVersion,
    writableBy: origin?.writableBy,
    branchableBy: origin?.branchableBy,
    ext: origin?.ext
  });

/** Per-connection context the subscription methods need to wire an event sink. */
export interface RpcContext {
  state: ConnectionState;
  push: Push;
}

type RpcHandlerMap = {
  [M in RpcMethod]: (
    params: RpcParams<M>,
    handlers: ReturnType<typeof createDaemonHandlers>,
    ctx: RpcContext
  ) => Promise<RpcResult<M>>;
};

type D = ReturnType<typeof createDaemonHandlers>;

// Several methods rename the wire `sessionId` to handlers' `id` — absorbed
// per-handler via destructure + spread so the rename lives in exactly one place.
export const RPC_HANDLERS: RpcHandlerMap = {
  health: (_params, h: D) => h.health(),

  // The wire folds the session id into `id` (matching the HTTP `:id` path param);
  // handlers that take `sessionId` get the rename absorbed here, in one place.
  'sessions.list': ({ archived, state, limit, offset }, h: D) => h.session.list({ archived, state, limit, offset }),
  'sessions.get': ({ id }, h: D) => h.session.get({ id }),
  // The native JSON-RPC socket is the CLI/TUI control plane — it shares the `http` write-class
  // (both are owner-local control transports), defaulting to the `tui` surface.
  'sessions.create': ({ title, agentId, origin, cwd }, h: D) =>
    h.session.create({ title, agentId, origin: nativeOrigin(origin), cwd }),
  'sessions.update': ({ id, ...rest }, h: D) => h.session.update({ id, ...rest }),
  'sessions.delete': ({ id }, h: D) => h.session.delete({ id }),
  'sessions.abort': ({ id }, h: D) => h.session.abort({ id }),
  'sessions.reset': ({ id }, h: D) => h.session.reset({ id }),
  'sessions.messages': ({ id, ...rest }, h: D) => h.session.messages({ id, ...rest }),
  'sessions.branch': ({ id, title, atMessageId, origin }, h: D) =>
    h.session.branch({ id, title, atMessageId, origin: nativeOrigin(origin) }),
  'sessions.provenance': ({ id }, h: D) => h.session.provenance({ id }),
  'sessions.restore': ({ id, ...rest }, h: D) => h.session.restore({ id, ...rest }),
  'sessions.search': (params, h: D) => h.session.search(params),
  'sessions.send': ({ id, ...rest }, h: D) => h.session.send({ sessionId: id, ...rest }),
  'sessions.generate': ({ id, ...rest }, h: D) => h.session.generate({ sessionId: id, ...rest }),

  'control.subscribe': async (_params, h: D, { state, push }) => {
    // Idempotent: a second control.subscribe on this connection is a no-op.
    if (!state.control) {
      const sink: EventSink = (event) => {
        push({
          jsonrpc: '2.0',
          method: 'sessions.event',
          params: { sessionId: event.sessionId, event }
        });
      };
      const { dispose } = h.session.subscribeControl(sink);
      state.control = dispose;
    }
    return { subscribed: true };
  },
  'control.unsubscribe': async (_params, _h: D, { state }) => {
    state.control?.();
    state.control = undefined;
    return {};
  },

  'session.subscribe': async ({ id }, h: D, { state, push }) => {
    if (!state.sessions) state.sessions = new Map();
    if (!state.sessions.has(id)) {
      const sink: EventSink = (event) => {
        push({ jsonrpc: '2.0', method: 'sessions.event', params: { sessionId: id, event } });
      };
      const { dispose } = await h.session.subscribe({ sessionId: id }, sink);
      state.sessions.set(id, dispose);
    }
    return { subscribed: true };
  },
  'session.unsubscribe': async ({ id }, _h: D, { state }) => {
    state.sessions?.get(id)?.();
    state.sessions?.delete(id);
    return {};
  },

  'tools.approve': (params, h: D) => h.oversight.approve(params),

  'approvals.list': (params, h: D) => h.oversight.list(params),
  'approvals.revoke': (params, h: D) => h.oversight.revoke(params),
  'approvals.clear': (params, h: D) => h.oversight.clear(params),

  'clarify.respond': (params, h: D) => h.clarify.respond(params),

  'skills.list': (params, h: D) => h.skills.list(params),
  'settings.skills.get': (_params, h: D) => h.skillsSettings.getSkillsSettings(),
  'settings.skills.set': (params, h: D) => h.skillsSettings.setSkillsSettings(params),

  'commands.list': (_params, h: D) => h.commands.list(),

  'agents.list': (_params, h: D) => h.agent.listAgents(),
  'agents.get': ({ id }, h: D) => h.agent.getAgent({ agentId: id }),
  'agents.create': (params, h: D) => h.agent.createAgent(params),
  'agents.update': ({ id, ...patch }, h: D) => h.agent.updateAgent({ agentId: id, ...patch }),
  'agents.delete': ({ id }, h: D) => h.agent.deleteAgent({ agentId: id }),
  'agents.prompt.get': ({ id }, h: D) => h.agent.getAgentPrompt({ agentId: id }),
  'agents.prompt.set': ({ id, prompt }, h: D) => h.agent.setAgentPrompt({ agentId: id, prompt: prompt as string }),
  'agents.default.get': (_params, h: D) => h.agent.getDefaultAgent(),
  'agents.default.set': ({ agentId }, h: D) => h.agent.setDefaultAgent({ agentId }),

  'nativeCli.start': async ({ id, ...request }, h: D) => h.nativeCli.start({ sessionId: id, request }),
  'nativeCli.list': async ({ id }, h: D) => h.nativeCli.list({ sessionId: id }),
  'nativeCli.get': async ({ id }, h: D) => h.nativeCli.get({ id }),
  'nativeCli.input': async ({ id, ...request }, h: D) => h.nativeCli.input({ id, ...request }),
  'nativeCli.approval': async ({ id, ...request }, h: D) => h.nativeCli.approval({ id, ...request }),
  'nativeCli.resize': async ({ id, ...request }, h: D) => h.nativeCli.resize({ id, ...request }),
  'nativeCli.stop': async ({ id }, h: D) => h.nativeCli.stop({ id }),
  'nativeCli.historyPage': async ({ id, ...request }, h: D) => h.nativeCli.historyPage({ id, request }),
  'nativeCli.auth.start': async ({ name }, h: D) => h.nativeCli.startAuth({ agentName: name }),
  'nativeCli.auth.status': async ({ name }, h: D) => h.nativeCli.authStatus({ agentName: name }),
  'nativeCli.auth.get': async ({ id }, h: D) => h.nativeCli.getAuth({ id }),
  'nativeCli.auth.input': async ({ id, ...request }, h: D) => h.nativeCli.inputAuth({ id, ...request }),
  'nativeCli.auth.resize': async ({ id, ...request }, h: D) => h.nativeCli.resizeAuth({ id, ...request }),
  'nativeCli.auth.stop': async ({ id }, h: D) => h.nativeCli.stopAuth({ id })

  // model/* settings (and the rest of /v1/settings/*) are HTTP-only — no RPC binding by design.
};
