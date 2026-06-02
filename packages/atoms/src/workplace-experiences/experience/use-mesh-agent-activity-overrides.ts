import type { UIItem } from '@monad/protocol';
import type { AgentActivityOverride } from './types.ts';

import { useEffect, useRef, useState } from 'react';

import { meshAgentFacingCommandPhase } from './mesh-agent-presence.ts';

/** Tracks a short-lived activity phase per MeshAgent name, derived from
 *  the tail of each running `mesh-agent:*` tool's output. An override expires on its own after 5s
 *  via a timer keyed to the soonest expiry, so a phase that isn't
 *  refreshed by a newer tool update clears itself without a follow-up render loop. */
export function useMeshAgentActivityOverrides(
  liveTools: Extract<UIItem, { kind: 'tool' }>[]
): Record<string, AgentActivityOverride> {
  const [meshAgentActivityOverrides, setMeshAgentActivityOverrides] = useState<Record<string, AgentActivityOverride>>(
    {}
  );
  // This effect fires on every streamed token. A tool call's input is immutable, so its
  // stringified form is cached per item id; only the output tail can newly match a phase.
  const meshAgentToolInputJson = useRef(new Map<string, string>());
  useEffect(() => {
    const now = Date.now();
    const next: Record<string, AgentActivityOverride> = {};
    let changed = false;
    for (const [agentName, override] of Object.entries(meshAgentActivityOverrides)) {
      if (override.expiresAt <= now) {
        changed = true;
        continue;
      }
      next[agentName] = override;
    }
    const inputJsonCache = meshAgentToolInputJson.current;
    if (inputJsonCache.size > 256) inputJsonCache.clear();
    for (const item of liveTools) {
      if (!item.tool.startsWith('mesh-agent:')) continue;
      if (item.status !== 'running') continue;
      const input = item.input as { agent?: unknown } | undefined;
      if (typeof input?.agent !== 'string') continue;
      let inputJson = inputJsonCache.get(item.id);
      if (inputJson === undefined) {
        inputJson = JSON.stringify(item.input ?? {});
        inputJsonCache.set(item.id, inputJson);
      }
      const outputTail = item.output && item.output.length > 500 ? item.output.slice(-500) : (item.output ?? '');
      const phase = meshAgentFacingCommandPhase(`${inputJson}\n${outputTail}`);
      if (!phase) continue;
      const expiresAt = now + 5000;
      const current = next[input.agent];
      if (!current || current.phase !== phase) {
        next[input.agent] = { phase, expiresAt };
        changed = true;
      }
    }
    if (changed) setMeshAgentActivityOverrides(next);
  }, [liveTools, meshAgentActivityOverrides]);
  useEffect(() => {
    const expiresAt = Math.min(...Object.values(meshAgentActivityOverrides).map((override) => override.expiresAt));
    if (!Number.isFinite(expiresAt)) return;
    const timer = window.setTimeout(
      () => {
        const now = Date.now();
        setMeshAgentActivityOverrides((current) =>
          Object.fromEntries(Object.entries(current).filter(([, override]) => override.expiresAt > now))
        );
      },
      Math.max(0, expiresAt - Date.now())
    );
    return () => window.clearTimeout(timer);
  }, [meshAgentActivityOverrides]);

  return meshAgentActivityOverrides;
}
