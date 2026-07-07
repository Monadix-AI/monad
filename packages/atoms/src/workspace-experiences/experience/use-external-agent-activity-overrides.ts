import type { UIItem } from '@monad/protocol';
import type { AgentActivityOverride } from './types.ts';

import { useEffect, useRef, useState } from 'react';

import { externalAgentFacingCommandPhase } from './external-agent-presence.ts';

/** Tracks a short-lived activity phase per external agent name, derived from
 *  the tail of each running `external-agent:*` tool's output. An override expires on its own after 5s
 *  via a timer keyed to the soonest expiry, so a phase that isn't
 *  refreshed by a newer tool update clears itself without a follow-up render loop. */
export function useExternalAgentActivityOverrides(
  liveTools: Extract<UIItem, { kind: 'tool' }>[]
): Record<string, AgentActivityOverride> {
  const [externalAgentActivityOverrides, setExternalAgentActivityOverrides] = useState<
    Record<string, AgentActivityOverride>
  >({});
  // This effect fires on every streamed token. A tool call's input is immutable, so its
  // stringified form is cached per item id; only the output tail can newly match a phase.
  const externalAgentToolInputJson = useRef(new Map<string, string>());
  useEffect(() => {
    const now = Date.now();
    const next: Record<string, AgentActivityOverride> = {};
    let changed = false;
    for (const [agentName, override] of Object.entries(externalAgentActivityOverrides)) {
      if (override.expiresAt <= now) {
        changed = true;
        continue;
      }
      next[agentName] = override;
    }
    const inputJsonCache = externalAgentToolInputJson.current;
    if (inputJsonCache.size > 256) inputJsonCache.clear();
    for (const item of liveTools) {
      if (!item.tool.startsWith('external-agent:')) continue;
      if (item.status !== 'running') continue;
      const input = item.input as { agent?: unknown } | undefined;
      if (typeof input?.agent !== 'string') continue;
      let inputJson = inputJsonCache.get(item.id);
      if (inputJson === undefined) {
        inputJson = JSON.stringify(item.input ?? {});
        inputJsonCache.set(item.id, inputJson);
      }
      const outputTail = item.output && item.output.length > 500 ? item.output.slice(-500) : (item.output ?? '');
      const phase = externalAgentFacingCommandPhase(`${inputJson}\n${outputTail}`);
      if (!phase) continue;
      const expiresAt = now + 5000;
      const current = next[input.agent];
      if (!current || current.phase !== phase) {
        next[input.agent] = { phase, expiresAt };
        changed = true;
      }
    }
    if (changed) setExternalAgentActivityOverrides(next);
  }, [liveTools, externalAgentActivityOverrides]);
  useEffect(() => {
    const expiresAt = Math.min(...Object.values(externalAgentActivityOverrides).map((override) => override.expiresAt));
    if (!Number.isFinite(expiresAt)) return;
    const timer = window.setTimeout(
      () => {
        const now = Date.now();
        setExternalAgentActivityOverrides((current) =>
          Object.fromEntries(Object.entries(current).filter(([, override]) => override.expiresAt > now))
        );
      },
      Math.max(0, expiresAt - Date.now())
    );
    return () => window.clearTimeout(timer);
  }, [externalAgentActivityOverrides]);

  return externalAgentActivityOverrides;
}
