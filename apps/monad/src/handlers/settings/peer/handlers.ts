import type { PeerConfig } from '@monad/home';
import type {
  GetPeerResponse,
  ListPeersResponse,
  OkResponse,
  PeerView,
  SetPeerCredentialRequest,
  TestPeerConnectionResponse,
  UpsertPeerRequest
} from '@monad/protocol';
import type { PeerSettingsContext } from '@/handlers/settings/peer/context.ts';

import { HandlerError } from '@/handlers/handler-error.ts';

const PEER_TEST_CONNECTION_TIMEOUT_MS = 5_000;

function toView(p: PeerConfig): PeerView {
  // tokenRef is intentionally dropped — secret material never crosses the wire.
  return {
    id: p.id as PeerView['id'],
    label: p.label,
    baseUrl: p.baseUrl,
    defaultAgent: p.defaultAgent,
    enabled: p.enabled
  };
}

export function createPeerHandlers(ctx: PeerSettingsContext) {
  return {
    async listPeers(): Promise<ListPeersResponse> {
      const { cfg } = await ctx.read();
      return { peers: cfg.peers.map(toView) };
    },

    async getPeer({ id }: { id: string }): Promise<GetPeerResponse> {
      const { cfg } = await ctx.read();
      const found = cfg.peers.find((p) => p.id === id);
      if (!found) throw new HandlerError('not_found', `peer not found: ${id}`);
      return { peer: toView(found) };
    },

    async upsertPeer({ peer }: UpsertPeerRequest): Promise<OkResponse> {
      const { cfg } = await ctx.read();
      const existing = cfg.peers.find((p) => p.id === peer.id);
      const next: PeerConfig = {
        ...peer,
        // Preserve an existing token reference; default new peers to the auth.json-backed scheme.
        tokenRef: existing?.tokenRef ?? `\${secret:peer/${peer.id}/token}`
      };
      const peers = existing ? cfg.peers.map((p) => (p.id === peer.id ? next : p)) : [...cfg.peers, next];
      await ctx.commit({ ...cfg, peers });
      return { ok: true };
    },

    async setPeerEnabled({ id, enabled }: { id: string; enabled: boolean }): Promise<OkResponse> {
      const { cfg } = await ctx.read();
      if (!cfg.peers.some((p) => p.id === id)) throw new HandlerError('not_found', `peer not found: ${id}`);
      const peers = cfg.peers.map((p) => (p.id === id ? { ...p, enabled } : p));
      await ctx.commit({ ...cfg, peers });
      return { ok: true };
    },

    async removePeer({ id }: { id: string }): Promise<OkResponse> {
      const { cfg, auth } = await ctx.read();
      if (!cfg.peers.some((p) => p.id === id)) throw new HandlerError('not_found', `peer not found: ${id}`);
      const peers = cfg.peers.filter((p) => p.id !== id);
      if (auth.peerCredentials?.[id]) {
        const peerCredentials = { ...auth.peerCredentials };
        delete peerCredentials[id];
        await ctx.commit({ ...cfg, peers }, { ...auth, peerCredentials });
      } else {
        await ctx.commit({ ...cfg, peers });
      }
      return { ok: true };
    },

    // Token lands in auth.json (owner-only); config.json keeps only the `${secret:peer/<id>/token}`
    // reference. Setting a token also enables the peer so the delegate tool offers it on next start.
    async setPeerCredential({ id, token }: { id: string } & SetPeerCredentialRequest): Promise<OkResponse> {
      const { cfg, auth } = await ctx.read();
      if (!cfg.peers.some((p) => p.id === id)) throw new HandlerError('not_found', `peer not found: ${id}`);
      const peers = cfg.peers.map((p) => (p.id === id ? { ...p, enabled: true } : p));
      const peerCredentials = { ...(auth.peerCredentials ?? {}), [id]: { token } };
      await ctx.commit({ ...cfg, peers }, { ...auth, peerCredentials });
      return { ok: true };
    },

    // Reachability probe: hits the peer daemon's own /health alongside its configured OpenAI-compat
    // base (baseUrl is e.g. `http://host:port/openai`; /health is a sibling route on the same daemon
    // root — see apps/monad/src/transports/http.ts). Uses the stored bearer token when present, same
    // as the real delegation call, so an auth-misconfigured peer surfaces as unreachable here too.
    async testPeerConnection({ id }: { id: string }): Promise<TestPeerConnectionResponse> {
      const { cfg, auth } = await ctx.read();
      const peer = cfg.peers.find((p) => p.id === id);
      if (!peer) throw new HandlerError('not_found', `peer not found: ${id}`);

      const healthUrl = new URL(peer.baseUrl);
      healthUrl.pathname = healthUrl.pathname.replace(/\/openai\/?$/, '/health');
      const token = auth.peerCredentials?.[id]?.token;

      const startedAt = Date.now();
      try {
        const res = await fetch(healthUrl, {
          headers: token ? { authorization: `Bearer ${token}` } : undefined,
          signal: AbortSignal.timeout(PEER_TEST_CONNECTION_TIMEOUT_MS)
        });
        if (!res.ok) return { ok: false, latencyMs: Date.now() - startedAt, error: `HTTP ${res.status}` };
        return { ok: true, latencyMs: Date.now() - startedAt };
      } catch (err) {
        return {
          ok: false,
          latencyMs: Date.now() - startedAt,
          error: err instanceof Error ? err.message : String(err)
        };
      }
    }
  };
}
