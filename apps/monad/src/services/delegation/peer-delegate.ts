// monad delegating to a PEER daemon: the `agent_peer_delegate` tool drives a configured peer's
// OpenAI-compat API (POST /openai/v1/chat/completions) to carry out a self-contained subtask and
// returns its final answer. Unlike acp-delegate, the peer is self-contained — it runs on its OWN
// fs/tools/credentials, so there is NO filesystem/terminal bridge-back.
//
// Trust + containment: the model supplies a peer NAME (+ optional agent name), never a URL or token
// — that would be SSRF / credential leak. Only operator-configured, enabled peers are reachable, and
// the tool is high-risk so each delegation is gated by oversight once. The peer's own approval gate
// (local/auto on its side) governs what it may do; forward-to-here approval arrives with the PeerLink
// transport (P1).

import type { Tool, ToolContext, ToolGate } from '#/capabilities/tools/types.ts';

import { createLogger } from '@monad/logger';
import { z } from 'zod';

import { toolResult } from '#/capabilities/tools/types.ts';

const log = createLogger('peer-delegate');

/** A configured peer resolved to a usable target (token already resolved from auth.json). */
export interface PeerDelegateTarget {
  id: string;
  label: string;
  /** OpenAI-compat base, e.g. http://host:port/openai (no /v1 suffix). */
  baseUrl: string;
  defaultAgent: string;
  token: string;
}

export interface PeerDelegateDeps {
  /** Enabled peers with resolved tokens. Empty → the tool still registers but offers nothing. */
  peers: PeerDelegateTarget[];
  /** Oversight gate — delegating to a peer is a network escalation gated once here. */
  gate?: ToolGate;
}

const delegateInput = z.object({
  peer: z.string().min(1).describe('Name of a configured peer daemon to delegate to'),
  agent: z.string().min(1).optional().describe("Target agent on the peer (defaults to the peer's configured agent)"),
  instruction: z.string().min(1).describe('A self-contained instruction for the peer to carry out')
});
type DelegateInput = z.infer<typeof delegateInput>;

interface OAIStreamChunk {
  choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
}

/** Drive one peer chat-completion to completion over SSE, surfacing partial text via reportProgress. */
async function runPeerDelegation(
  peer: PeerDelegateTarget,
  agent: string,
  instruction: string,
  ctx: ToolContext
): Promise<string> {
  const url = `${peer.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${peer.token}` },
    body: JSON.stringify({
      model: agent,
      messages: [{ role: 'user', content: instruction }],
      stream: true,
      // Stable key so a follow-up turn to the same peer can reuse the peer-side session (P2 multi-turn).
      user: `peer-delegate:${ctx.sessionId}`
    }),
    signal: ctx.signal
  });

  if (!res.ok || !res.body) {
    // Never surface the bearer; lift the peer's OpenAI-style error message when present.
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body.error?.message) detail = `${detail}: ${body.error.message}`;
    } catch {
      // non-JSON body — keep the status line
    }
    throw new Error(`peer "${peer.label}" rejected the delegation (${detail})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line.
      let sep = buffer.indexOf('\n\n');
      for (; sep !== -1; sep = buffer.indexOf('\n\n')) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        const payload = dataLine.slice(5).trim();
        if (payload === '[DONE]') continue;
        let chunk: OAIStreamChunk;
        try {
          chunk = JSON.parse(payload) as OAIStreamChunk;
        } catch {
          continue;
        }
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          text += delta;
          ctx.reportProgress?.(text);
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return text;
}

/** Build the `agent_peer_delegate` tool from the configured, enabled peers. */
export function createPeerDelegateTool(deps: PeerDelegateDeps): Tool<DelegateInput, { text: string }> {
  const peers = deps.peers;
  const catalog = peers.map((p) => `${p.label} (agent: ${p.defaultAgent})`).join(', ') || 'none configured';
  return {
    name: 'agent_peer_delegate',
    description:
      'Delegate a self-contained subtask to a peer Monad daemon, returning its final answer. The peer ' +
      `runs it on its own tools and credentials. Available peers: ${catalog}.`,
    scopes: [{ resource: 'agent:delegate' }],
    // Delegating to a networked peer is a real escalation → route through the oversight gate once.
    highRisk: true,
    inputSchema: delegateInput,
    run: async ({ peer, agent, instruction }, ctx) => {
      const target = peers.find((p) => p.id === peer || p.label.toLowerCase() === peer.toLowerCase());
      if (!target) {
        const names = peers.map((p) => p.label).join(', ') || 'none';
        throw new Error(`unknown peer "${peer}" (configured: ${names})`);
      }
      const targetAgent = agent ?? target.defaultAgent;
      log.info({ peer: target.id, agent: targetAgent }, 'delegating to peer daemon');
      const text = await runPeerDelegation(target, targetAgent, instruction, ctx);
      return toolResult({ text });
    }
  };
}
