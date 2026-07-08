import type {
  ApprovalMutationResponse,
  ApprovalScope,
  ListApprovalsResponse,
  PickDirectoryResponse,
  SystemUpgradeStatus
} from '@monad/protocol';
import type { DelegationService } from '#/services/delegation/delegation.ts';
import type { ClarifyService } from '#/services/generation/clarify.ts';
import type { OversightService } from '#/services/oversight.ts';

import { pickDirectory } from '@monad/home';

import { createSystemUpgradeModule } from '#/handlers/system-upgrade.ts';

/** Human-in-the-loop control surfaces with no dependency on the rest of the daemon composition
 *  root: tool-approval gate CRUD, the clarify_ask response channel, the native directory picker,
 *  and reverse fs/terminal delegation responses from an ACP-bridged editor. Extracted from
 *  handlers.ts — each object only needs its one named service off `deps`. */
export function createOversightHandlers(oversight: OversightService) {
  return {
    async approve({
      requestId,
      allow,
      reason,
      scope
    }: {
      requestId: string;
      allow: boolean;
      reason?: string;
      scope?: ApprovalScope;
    }): Promise<{ ok: boolean }> {
      return { ok: await oversight.respond(requestId, allow, reason, scope) };
    },
    async list({
      sessionId,
      limit,
      before
    }: {
      sessionId?: string;
      limit?: number;
      before?: string;
    } = {}): Promise<ListApprovalsResponse> {
      const all = oversight.listApprovals(sessionId);
      const sorted = [...all].sort((a, b) => a.id.localeCompare(b.id));
      const startIdx = before ? sorted.findIndex((r) => r.id === before) : -1;
      const rest = startIdx >= 0 ? sorted.slice(startIdx + 1) : sorted;
      const pageLimit = limit ?? rest.length;
      const page = rest.slice(0, pageLimit);
      const nextCursor = rest.length > pageLimit ? page[page.length - 1]?.id : undefined;
      return { rules: page, nextCursor };
    },
    async revoke({ id }: { id: string }): Promise<ApprovalMutationResponse> {
      return { ok: await oversight.revokeApproval(id) };
    },
    async clear({
      scope,
      agentId
    }: {
      scope?: 'session' | 'agent' | 'global';
      agentId?: string;
    } = {}): Promise<ApprovalMutationResponse> {
      const removed = await oversight.clearApprovals({ scope, agentId });
      return { ok: true, removed };
    }
  };
}

export function createClarifyHandlers(clarify: ClarifyService) {
  return {
    askStructured: clarify.askStructured,
    async respond({ requestId, answer }: { requestId: string; answer: string }): Promise<{ ok: boolean }> {
      return { ok: clarify.respond(requestId, answer) };
    }
  };
}

export function createSystemHandlers(upgrade: ReturnType<typeof createSystemUpgradeModule>) {
  return {
    async pickDirectory({
      prompt,
      defaultPath
    }: {
      prompt?: string;
      defaultPath?: string;
    }): Promise<PickDirectoryResponse> {
      return { path: await pickDirectory({ prompt, defaultPath }) };
    },
    async getUpgradeStatus(): Promise<SystemUpgradeStatus> {
      return upgrade.getStatus();
    },
    async startUpgrade(): Promise<SystemUpgradeStatus> {
      return upgrade.start();
    }
  };
}

// Reverse fs/terminal delegation responses from the ACP bridge (editor). `respond` settles a
// pending fs/terminal request; `output` streams cumulative terminal output while it runs.
export function createDelegationHandlers(delegation: DelegationService | undefined) {
  return {
    async respond({
      requestId,
      ok,
      result,
      error
    }: {
      requestId: string;
      ok: boolean;
      result?: unknown;
      error?: string;
    }): Promise<{ ok: boolean }> {
      return { ok: delegation?.respond(requestId, ok, result, error) ?? false };
    },
    async output({ requestId, output }: { requestId: string; output: string }): Promise<{ ok: boolean }> {
      return { ok: delegation?.output(requestId, output) ?? false };
    }
  };
}
