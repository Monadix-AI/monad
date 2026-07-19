import type { MeshAgentOutputEvent, MeshAgentProviderEventPageRequestContext } from '@monad/sdk-atom';
import type { GatewayCliHooks } from '../../legacy/gateway-cli-adapter.ts';
import type {
  LegacyProviderApprovalResolution as MeshAgentApprovalResolution,
  LegacyProviderInitializeContext as MeshAgentInitializeContext,
  LegacyProviderRuntimeHandle as MeshAgentRuntimeHandle
} from '../../legacy/runtime.ts';

import { compactObject, parseJsonObject } from '../../adapter-shared.ts';
import { recordValue } from '../../legacy/gateway-cli-adapter.ts';
import {
  buildDeviceAuthPayloadV3,
  createOpenClawDeviceIdentity,
  type OpenClawDeviceIdentity,
  signDevicePayload
} from '../device-identity.ts';

// OpenClaw's gateway (`openclaw gateway`, default ws://127.0.0.1:18789) does NOT speak generic
// JSON-RPC 2.0 — every frame is wrapped in a `{type: "req"|"res"|"event", ...}` envelope with `ok`/
// `payload` instead of `result`/`error`, and every `id` is a STRING (a numeric id is rejected as
// "invalid request frame"). This file is NOT speculative: it was verified 2026-07-04 against a locally
// running `openclaw gateway run --dev` (v2026.6.11) two ways —
//   1. Reading the real TypeBox schema OpenClaw ships at
//      node_modules/openclaw/dist/plugin-sdk/src/gateway/protocol/schema/{frames,sessions,exec-approvals}.d.ts
//      (RequestFrameSchema/ResponseFrameSchema/EventFrameSchema, ConnectParamsSchema,
//      SessionsCreateParamsSchema, SessionsSendParamsSchema, ExecApprovalResolveParamsSchema).
//   2. Driving that schema live with the exported `GatewayClient` (openclaw/plugin-sdk/gateway-runtime)
//      and a raw WebSocket, observing real `sessions.create`/`sessions.send` results and `chat` events.
// Only `exec.approval.requested`'s exact payload shape is NOT live-observed (no live tool-approval was
// triggered) — it's inferred from `ExecApprovalRequestParamsSchema` + the confirmed `id` field name.
//
// The connect handshake carries an Ed25519 device signature (see device-identity.ts + the connect flow
// below) — verified live 2026-07-05 to be what grants `operator.write`: a token-only connect is accepted
// but scoped empty, so `sessions.create` fails `missing scope: operator.write`; a signed connect is
// granted the requested scopes directly (no interactive `devices approve` step).

interface OpenClawEnvelope extends Record<string, unknown> {
  type?: string;
  id?: unknown;
  method?: string;
  event?: string;
  ok?: boolean;
  payload?: unknown;
  /** ResponseFrameSchema puts rejection details HERE, not in `payload` (which is absent/empty on a
   *  rejected response) — live-confirmed: `{type:"res",ok:false,error:{code,message,retryable,
   *  retryAfterMs,details}}`. */
  error?: unknown;
}

/** `ConnectParamsSchema.client.id`: a closed enum — OpenClaw's gateway rejects any id outside this set
 *  (verified live: an arbitrary string 400s with "must be equal to one of the allowed values"). `'cli'`
 *  is the closest fit for a headless external orchestrator; there is no "third-party integration" id. */
const CONNECT_CLIENT_ID = 'cli';
/** `ConnectParamsSchema.client.mode`: same closed-enum story as `client.id`. */
const CONNECT_CLIENT_MODE = 'cli';
const CONNECT_ROLE = 'operator';
/** `operator.write` is what `sessions.create`/`sessions.send` require; the gateway only grants it to a
 *  connection carrying a valid device signature (a token-only connect is granted an empty scope set). */
const CONNECT_SCOPES = ['operator.read', 'operator.write'];

interface OpenClawConnectState {
  identity: OpenClawDeviceIdentity;
  /** Frame id reserved for the `connect` request, sent once the gateway's challenge nonce arrives. */
  connectId: string;
  /** Shared gateway token (or `''`); part of both `auth` and the signed payload — see device-identity. */
  token: string;
  sessionFrame: string;
}

// Per-session signing state, populated by `openClawInitialize` and consumed when the gateway's
// `connect.challenge` frame arrives (the nonce is required in the signed payload, so the `connect`
// request can't be sent until then). Keyed by handle so a reconnect — which re-invokes `initialize`
// with a fresh identity — is naturally independent. A WeakMap avoids widening the runtime-handle type.
const connectStates = new WeakMap<MeshAgentRuntimeHandle, OpenClawConnectState>();

let nextFrameSeq = 0;
/** Frame ids must be strings (`RequestFrameSchema.id: TString`); `handle.nextRequestId()` returns a
 *  number, so every id that crosses the wire is stringified here rather than at each call site. */
function frameId(handle: MeshAgentRuntimeHandle): string {
  return String(handle.nextRequestId?.() ?? nextFrameSeq++);
}

function req(method: string, id: string, params: Record<string, unknown>): string {
  return `${JSON.stringify({ type: 'req', id, method, params })}\n`;
}

export function openClawInitialize(handle: MeshAgentRuntimeHandle, context: MeshAgentInitializeContext): void {
  if (handle.launchMode !== 'gateway' || !handle.gateway) return;
  const connectId = frameId(handle);
  const sessionId = frameId(handle);
  handle.pendingRequests?.set(connectId, 'initialize');
  handle.pendingRequests?.set(sessionId, context.providerSessionRef ? 'sessionResume' : 'sessionStart');

  // `sessions.create` params (SessionsCreateParamsSchema): key/agentId/label/model/parentSessionKey/
  // emitCommandHooks/task/message, all optional. There is no dedicated "resume" method; `sessions.resolve`
  // ("resolves or canonicalizes a session target") takes the same optional `key`, so passing the
  // persisted key there is the closest documented resume path.
  const modelParam = context.modelId ?? context.modelName;
  const sessionParams = compactObject({ model: modelParam });
  const sessionMethod = context.providerSessionRef ? 'sessions.resolve' : 'sessions.create';
  const sessionFrame = req(
    sessionMethod,
    sessionId,
    context.providerSessionRef ? { key: context.providerSessionRef, ...sessionParams } : sessionParams
  );

  // The `connect` request carries an Ed25519 device signature over a nonce the gateway issues in a
  // `connect.challenge` event on socket open — so it can't be built here; `handleConnectChallenge`
  // sends it when that nonce arrives. Two credentials combine:
  //   - The shared token (`connect.params.auth.token`) — explicit per-agent config via
  //     `agent.env.OPENCLAW_GATEWAY_TOKEN`, the same map the daemon forwards to the spawned
  //     `openclaw gateway run` process so it self-selects token mode. Never a Monad-invented ambient var.
  //     A token-mode gateway rejects a connect with no token (`AUTH_TOKEN_MISSING`), so without it
  //     gateway mode fails fast with a `connection_required` event rather than hanging.
  //   - The device signature — what actually authorizes `operator.write` (a token-only connect is
  //     accepted but granted an empty scope set, so `sessions.create` would fail `missing scope`). This
  //     replaces OpenClaw's interactive `devices approve` pairing: a valid signature grants the
  //     requested scopes directly.
  connectStates.set(handle, {
    identity: createOpenClawDeviceIdentity(),
    connectId,
    token: context.env?.OPENCLAW_GATEWAY_TOKEN ?? '',
    sessionFrame
  });
}

/** Answer the gateway's `connect.challenge` by sending the signed `connect` request. The nonce is part
 *  of the signed v3 payload, so this is the earliest point the request can be built. Fires once per
 *  (re)connect — `initialize` repopulates the state with a fresh identity each time.
 *
 *  A rejected connect (e.g. `retryable:true` while sidecar plugins are still loading) is NOT retried
 *  here: OpenClaw closes the socket as part of rejecting a connect (WS close code 1013, live-confirmed
 *  against its source — `closeCause: "startup-sidecars-pending"`), so there is no live connection left to
 *  resend on. The daemon's legacy gateway reconnect path redials a
 *  fresh socket and re-invokes `initialize` in that case — see its comment for the transient-vs-fatal
 *  distinction. */
function handleConnectChallenge(
  payload: Record<string, unknown>,
  handle: MeshAgentRuntimeHandle | undefined
): MeshAgentOutputEvent[] {
  const state = handle ? connectStates.get(handle) : undefined;
  const nonce = typeof payload.nonce === 'string' ? payload.nonce : undefined;
  if (!handle?.gateway || !state || !nonce) return [];
  const signedAtMs = Date.now();
  const platform = process.platform;
  const authPayload = buildDeviceAuthPayloadV3({
    deviceId: state.identity.deviceId,
    clientId: CONNECT_CLIENT_ID,
    clientMode: CONNECT_CLIENT_MODE,
    role: CONNECT_ROLE,
    scopes: CONNECT_SCOPES,
    signedAtMs,
    token: state.token,
    nonce,
    platform
  });
  handle.gateway.send(
    req(
      'connect',
      state.connectId,
      compactObject({
        minProtocol: 3,
        maxProtocol: 4,
        client: { id: CONNECT_CLIENT_ID, displayName: 'monad', version: '0.1.0', platform, mode: CONNECT_CLIENT_MODE },
        role: CONNECT_ROLE,
        scopes: CONNECT_SCOPES,
        caps: [],
        auth: state.token ? { token: state.token } : undefined,
        device: {
          id: state.identity.deviceId,
          publicKey: state.identity.publicKeyRawBase64Url,
          signature: signDevicePayload(state.identity.privateKeyPem, authPayload),
          signedAt: signedAtMs,
          nonce
        }
      })
    )
  );
  return [];
}

function responseEvents(frame: OpenClawEnvelope, handle?: MeshAgentRuntimeHandle): MeshAgentOutputEvent[] {
  const idKey = typeof frame.id === 'string' ? frame.id : undefined;
  const kind = idKey !== undefined ? handle?.pendingRequests?.get(idKey) : undefined;
  if (idKey !== undefined && kind !== undefined) handle?.pendingRequests?.delete(idKey);

  if (frame.ok === false) {
    // ResponseFrameSchema puts rejection details in `error`, not `payload` (`payload` is absent/empty on
    // a rejected response) — live-confirmed shape: `{code,message,retryable,retryAfterMs,details}`.
    const errorInfo = recordValue(frame.error) ?? recordValue(frame.payload);
    // A `connect` rejected `retryable:true` (e.g. `UNAVAILABLE: gateway starting; retry shortly` while
    // sidecar plugins are still loading — live-confirmed) is transient, not an auth failure — surfacing
    // `connection_required` here would tear the session down immediately. OpenClaw closes the socket as
    // part of this rejection (WS close code 1013, live-confirmed against its source), so the daemon's own
    // gateway reconnect path will redial a fresh socket and
    // re-invoke `initialize`; emit nothing and let that happen instead of failing fast.
    if (kind === 'initialize' && errorInfo?.retryable === true) return [];
    // A rejected `connect` (kind 'initialize') is an auth failure — live-verified: a gateway with no
    // token configured 400s connect with `NOT_PAIRED`/`DEVICE_IDENTITY_REQUIRED`. That must surface the
    // same reconnect/auth-required signal as a rejected session start, not a generic provider_error.
    if (kind === 'initialize' || kind === 'sessionStart' || kind === 'sessionResume') {
      if (kind === 'initialize' && handle) connectStates.delete(handle);
      return [
        {
          type: 'connection_required',
          payload: compactObject({
            // `connection_required`'s schema requires `code` to be a non-empty string (stricter than
            // `provider_error`'s `string | number`) — guard it like `message` below, or a numeric/empty
            // real-world code would fail the whole event's zod validation and get silently dropped.
            code: typeof errorInfo?.code === 'string' && errorInfo.code.length > 0 ? errorInfo.code : undefined,
            reason:
              typeof errorInfo?.message === 'string' && errorInfo.message.length > 0
                ? errorInfo.message
                : 'OpenClaw requires reconnect'
          })
        }
      ];
    }
    return [
      {
        type: 'provider_error',
        payload: compactObject({
          responseId: idKey,
          code: errorInfo?.code,
          message: typeof errorInfo?.message === 'string' ? errorInfo.message : JSON.stringify(errorInfo ?? {})
        })
      }
    ];
  }

  const payload = recordValue(frame.payload);

  if (kind === 'initialize') {
    const state = handle ? connectStates.get(handle) : undefined;
    if (state?.sessionFrame && handle?.gateway) {
      handle.gateway.send(state.sessionFrame);
    }
    if (handle) connectStates.delete(handle); // connect succeeded — no more retries needed
    return [];
  }

  // Live-confirmed `sessions.create` result: `{ok, key, sessionId, entry:{...}, runStarted}` — `key` is
  // the routable session-target string every other method takes; `sessionId` is a separate internal id.
  if (kind === 'sessionStart' || kind === 'sessionResume') {
    const key = payload?.key;
    return typeof key === 'string' && key.length > 0
      ? [{ type: 'session_ref', payload: compactObject({ providerSessionRef: key, responseId: idKey }) }]
      : [];
  }
  if (kind === 'eventPage') {
    return [
      {
        type: 'event_page',
        payload: {
          responseId: idKey as string | number,
          items: Array.isArray(payload?.messages) ? payload.messages : [],
          nextCursor: null,
          backwardsCursor: null
        }
      }
    ];
  }
  return [];
}

function approvalRequestedEvent(payload: Record<string, unknown>): MeshAgentOutputEvent[] {
  // Not live-observed — inferred from ExecApprovalRequestParamsSchema (id/command/systemRunPlan) plus
  // the confirmed `id` field name from ExecApprovalResolveParamsSchema.
  const requestId = payload.id;
  if (typeof requestId !== 'string') return [];
  const plan = recordValue(payload.systemRunPlan);
  return [
    {
      type: 'approval_requested',
      payload: compactObject({
        requestId,
        kind: 'exec',
        tool: typeof payload.command === 'string' ? payload.command : plan?.commandText,
        command: payload.command ?? plan?.commandText,
        cwd: payload.cwd ?? plan?.cwd
      })
    }
  ];
}

function eventFrameEvents(eventName: string, payload: Record<string, unknown>): MeshAgentOutputEvent[] {
  switch (eventName) {
    case 'exec.approval.requested':
      return approvalRequestedEvent(payload);
    case 'exec.approval.resolved': {
      const requestId = payload.id;
      return typeof requestId === 'string'
        ? [{ type: 'approval_resolved', payload: compactObject({ requestId }) }]
        : [];
    }
    // Live-confirmed: `sessions.send` drives the SAME `chat` event stream as the higher-level
    // `chat.send` method (ChatEventSchema), discriminated by `state`. `deltaText` carries incremental
    // text; final/aborted/error carry `message.content` (Anthropic-style content-block array).
    case 'chat': {
      const state = payload.state;
      if (state === 'delta') {
        const deltaText = payload.deltaText;
        return typeof deltaText === 'string' && deltaText.length > 0
          ? [{ type: 'agent_message', payload: { text: deltaText } }]
          : [];
      }
      if (state === 'final' || state === 'aborted' || state === 'error') {
        const message = recordValue(payload.message);
        const content = Array.isArray(message?.content) ? message.content : [];
        const text = content
          .map((part) => (part && typeof part === 'object' && (part as { text?: unknown }).text) || '')
          .filter((part): part is string => typeof part === 'string')
          .join('');
        const errorMessage = typeof payload.errorMessage === 'string' ? payload.errorMessage : undefined;
        return [{ type: 'agent_message', payload: compactObject({ text: text || errorMessage || '', final: true }) }];
      }
      return [];
    }
    default:
      return [];
  }
}

export function parseOpenClawFrame(frame: OpenClawEnvelope, handle?: MeshAgentRuntimeHandle): MeshAgentOutputEvent[] {
  if (frame.type === 'res') return responseEvents(frame, handle);
  if (frame.type === 'event' && typeof frame.event === 'string') {
    // `connect.challenge` is answered by sending the signed `connect` request (needs the handle to
    // reach the socket + signing state), so it's handled here rather than in the payload-only translator.
    if (frame.event === 'connect.challenge') return handleConnectChallenge(recordValue(frame.payload) ?? {}, handle);
    return eventFrameEvents(frame.event, recordValue(frame.payload) ?? {});
  }
  return [];
}

export function parseOpenClawOutput(chunk: string, handle?: MeshAgentRuntimeHandle): MeshAgentOutputEvent[] {
  const events: MeshAgentOutputEvent[] = [];
  for (const rawLine of chunk.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;
    const record = parseJsonObject(line);
    if (!record) continue;
    events.push(...parseOpenClawFrame(record as OpenClawEnvelope, handle));
  }
  return events;
}

export function sendOpenClawInput(handle: MeshAgentRuntimeHandle, input: string): void {
  if (!handle.gateway) throw new Error('MeshAgent session has no OpenClaw gateway input bridge');
  if (!handle.providerSessionRef) throw new Error('OpenClaw gateway session is not ready');
  const id = frameId(handle);
  handle.pendingRequests?.set(id, 'turn');
  // Live-confirmed params (SessionsSendParamsSchema): {key, message, ...}. An earlier draft of this
  // adapter guessed `text` — the real gateway 400s with "must have required property 'message'".
  handle.gateway.send(req('sessions.send', id, { key: handle.providerSessionRef, message: input }));
}

export function requestOpenClawEventPage(
  handle: MeshAgentRuntimeHandle,
  request: MeshAgentProviderEventPageRequestContext['request']
): string | number {
  if (!handle.gateway) throw new Error('MeshAgent session has no OpenClaw gateway input bridge');
  if (!handle.providerSessionRef) throw new Error('OpenClaw gateway session is not ready');
  const id = frameId(handle);
  handle.pendingRequests?.set(id, 'eventPage');
  // ChatHistoryParamsSchema: {sessionKey, limit?, maxChars?}. The provider API has no cursor, so this
  // intentionally requests the latest `limit` messages and returns no nextCursor.
  handle.gateway.send(req('chat.history', id, { sessionKey: handle.providerSessionRef, limit: request.limit }));
  return id;
}

export function resolveOpenClawApproval(handle: MeshAgentRuntimeHandle, resolution: MeshAgentApprovalResolution): void {
  if (!handle.gateway) throw new Error('MeshAgent session has no OpenClaw gateway approval bridge');
  const id = frameId(handle);
  // ExecApprovalResolveParamsSchema: {id, decision}. ExecApprovalDecision (openclaw's own exported
  // type) is `"allow-once" | "allow-always" | "deny"` — a 3-way choice our binary `allow` maps onto the
  // non-persistent grant, never the persistent "always" one.
  handle.gateway.send(
    req('exec.approval.resolve', id, { id: resolution.requestId, decision: resolution.allow ? 'allow-once' : 'deny' })
  );
}

export const openClawGatewayHooks: GatewayCliHooks = {
  initialize: openClawInitialize,
  parseGatewayOutput: parseOpenClawOutput,
  sendGatewayInput: sendOpenClawInput,
  resolveGatewayApproval: resolveOpenClawApproval
};
