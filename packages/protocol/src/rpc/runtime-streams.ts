// Semantic-owner catalog for the daemon's non-Method live routes — the streaming and presentation
// surfaces that `METHOD_TABLE` (request/response Methods) deliberately does not cover. Together with
// METHOD_TABLE this is the binding catalog: every live route has exactly one semantic owner, and the
// binding-catalog conformance test asserts each entry is mounted and that no live route is an
// unclassified orphan (docs/internal/proposals/headless-runtime-mesh-engine-priorities.md, P0-A runtime track).
//
// `Stream` owns the long-lived planes: the global control WebSocket (`WS /v1/stream`), the per-session
// SSE planes (session events, per-message generation, neutral mesh-state, interaction events), and live
// MeshAgent observation (session + provider-auth). `Presentation` owns the retained server-side UI
// projection (`/ui-stream` SSE + `/ui-items` snapshot page) — a deliberate design surface
// (docs/internals/infra/realtime-channels.md), kept by decision, never treated as an orphan to delete.

export type SemanticRouteOwner =
  | 'method'
  | 'stream'
  | 'presentation'
  | 'protocol-adapter'
  | 'resource'
  | 'extension-gateway'
  | 'development';

// The route kinds the catalog represents. `GET` covers SSE and snapshot reads; `WS` is the WebSocket
// upgrade; the write verbs and Elysia's `ALL` (a catch-all mount, e.g. the experience gateway) cover the
// resource / protocol-adapter / extension-gateway / development owners.
export type RouteBindingKind = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'ALL' | 'WS';

export type NonMethodRouteOwner = Exclude<SemanticRouteOwner, 'method'>;

/** A non-Method live route bound to a semantic owner. `:param` placeholders name the route params.
 *  The `Owner` parameter lets each registry pin its own owner at the type level (so a mis-placed owner
 *  fails to compile), while the default union types aggregate/read-only views. */
export type RuntimeBindingDef<Owner extends NonMethodRouteOwner = NonMethodRouteOwner> = {
  readonly method: RouteBindingKind;
  readonly template: string;
  readonly owner: Owner;
  /** Stable Runtime API capability this route belongs to (revision-1 catalog names where applicable). */
  readonly capability: string;
};

// Long-lived stream planes. None has a JSON-RPC request/response twin (they are subscribe-then-stream).
// `controlStream` is the multiplexed WebSocket control plane; the rest are Server-Sent Events.
export const RUNTIME_STREAMS = {
  controlStream: { method: 'WS', template: '/v1/stream', owner: 'stream', capability: 'runtime.events' },
  sessionEvents: { method: 'GET', template: '/v1/sessions/:id/events', owner: 'stream', capability: 'session.events' },
  messageGeneration: {
    method: 'GET',
    template: '/v1/sessions/:id/messages/:messageId/stream',
    owner: 'stream',
    capability: 'agent.generation'
  },
  sessionMeshState: {
    method: 'GET',
    template: '/v1/sessions/:id/mesh-state/stream',
    owner: 'stream',
    capability: 'session.events'
  },
  interactionEvents: {
    method: 'GET',
    template: '/v1/interactions/events',
    owner: 'stream',
    capability: 'oversight.interaction'
  },
  meshObservationRaw: {
    method: 'GET',
    template: '/v1/mesh/sessions/:id/stream/raw',
    owner: 'stream',
    capability: 'runtime.events'
  },
  meshObservationConvenience: {
    method: 'GET',
    template: '/v1/mesh/sessions/:id/stream/convenience',
    owner: 'stream',
    capability: 'runtime.events'
  },
  meshSessionUsage: {
    method: 'GET',
    template: '/v1/mesh/sessions/:id/usage/events',
    owner: 'stream',
    capability: 'runtime.events'
  },
  meshAuthEvents: {
    method: 'GET',
    template: '/v1/mesh/auth-sessions/:id/events',
    owner: 'stream',
    capability: 'runtime.events'
  }
} as const satisfies Record<string, RuntimeBindingDef<'stream'>>;

// Retained server-side UI projection. `/ui-stream` streams neutral `SessionUiEvent`s over SSE;
// `/ui-items` is its paginated snapshot read. Both are owned by Presentation and kept by design.
export const PRESENTATION_ROUTES = {
  sessionUiStream: {
    method: 'GET',
    template: '/v1/sessions/:id/ui-stream',
    owner: 'presentation',
    capability: 'session.presentation'
  },
  sessionUiItems: {
    method: 'GET',
    template: '/v1/sessions/:id/ui-items',
    owner: 'presentation',
    capability: 'session.presentation'
  }
} as const satisfies Record<string, RuntimeBindingDef<'presentation'>>;

/** The `owner`-tagged non-Method routes cataloged so far (Stream + Presentation). */
export const SEMANTIC_ROUTE_BINDINGS: Readonly<Record<string, RuntimeBindingDef>> = {
  ...RUNTIME_STREAMS,
  ...PRESENTATION_ROUTES
};

/** `${method} ${template}` key for matching a binding against a live route. */
export function bindingRouteKey(binding: RuntimeBindingDef): string {
  return `${binding.method} ${binding.template}`;
}
