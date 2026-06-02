import type { PeerConfig } from '@monad/home';
import type {
  ListPeersResponse,
  OkResponse,
  PeerView,
  SetPeerCredentialRequest,
  UpsertPeerRequest
} from '@monad/protocol';
import type { PeerSettingsContext } from '@/handlers/settings/peer/context.ts';

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
      const peers = cfg.peers.map((p) => (p.id === id ? { ...p, enabled } : p));
      await ctx.commit({ ...cfg, peers });
      return { ok: true };
    },

    async removePeer({ id }: { id: string }): Promise<OkResponse> {
      const { cfg, auth } = await ctx.read();
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
      const peers = cfg.peers.map((p) => (p.id === id ? { ...p, enabled: true } : p));
      const peerCredentials = { ...(auth.peerCredentials ?? {}), [id]: { token } };
      await ctx.commit({ ...cfg, peers }, { ...auth, peerCredentials });
      return { ok: true };
    }
  };
}
