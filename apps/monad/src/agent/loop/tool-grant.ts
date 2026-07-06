import type { Hooks, TranscriptTargetId } from '@monad/protocol';
import type { ToolGate } from '@/capabilities/tools/types.ts';
import type { AgentLoopDeps } from './types.ts';

import { parseAllowedTools, toolMatchesAllowedPattern } from './skill-render.ts';

/**
 * Tool patterns pre-approved by skills active this turn (allowed-tools), and the gate wrapper that
 * auto-approves them while still routing everything else through hooks/deps.gate. The loop is
 * created fresh per turn, so this is turn-scoped — no cross-session/turn leakage.
 */
export class ToolGrant {
  private readonly grantedToolPatterns = new Set<string>();
  private gateWrapper?: ToolGate;

  constructor(
    private readonly deps: AgentLoopDeps,
    private readonly hooks: () => Hooks,
    private readonly hookCwd: () => string
  ) {}

  activateSkill(name: string): void {
    const skill = (this.deps.skills ?? []).find((s) => s.name === name);
    if (skill?.allowedTools) for (const p of parseAllowedTools(skill.allowedTools)) this.grantedToolPatterns.add(p);
  }

  private isToolGranted(toolName: string): boolean {
    for (const pattern of this.grantedToolPatterns) {
      if (toolMatchesAllowedPattern(pattern, toolName)) return true;
    }
    return false;
  }

  /**
   * The gate handed to invokeTool. When no skill has granted anything, it's the underlying
   * gate unchanged (so existing fail-closed behaviour is preserved). Once an active skill
   * grants a tool, that tool is auto-approved; everything else still defers to the gate.
   */
  effectiveGate(): ToolGate | undefined {
    // Build the wrapper once and reuse it across tool calls (grantedToolPatterns is read live inside
    // isToolGranted, so memoizing doesn't stale the grant set; deps.gate is stable for this loop).
    // Always wrap so ApprovalRequest fires whenever a tool actually reaches the gate (high-risk or
    // hook-forced). A hook may auto-deny or auto-approve; `ask`/no-decision defers to the human gate.
    // (ApprovalRequest with no configured hooks takes the runner's zero-allocation fast path.)
    if (!this.gateWrapper) {
      this.gateWrapper = async (request) => {
        if (this.isToolGranted(request.tool)) return { allow: true };
        const d = await this.hooks().run({
          event: 'ApprovalRequest',
          sessionId: request.sessionId as TranscriptTargetId,
          cwd: this.hookCwd(),
          timestamp: new Date().toISOString(),
          toolName: request.tool,
          toolInput: request.input
        });
        if (d.blocked) return { allow: false, reason: d.reason ?? 'denied by approval hook' };
        if (d.allowed && !d.ask) return { allow: true };
        if (this.deps.gate) return this.deps.gate(request);
        return { allow: false, reason: 'high-risk tool requires an approval gate but none is configured' };
      };
    }
    return this.gateWrapper;
  }
}
