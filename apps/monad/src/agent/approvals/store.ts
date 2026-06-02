// Persistent approval rules (agent + global scopes) backed by ~/.monad/approvals.json. Session
// rules never reach here — they live in the PolicyEngine's memory. A corrupt/unreadable file is
// treated as empty (fail-closed: missing rules just mean "ask"), never fail-open.

import type { ApprovalRule, ApprovalsFile } from '@monad/protocol';

import { chmod, rename } from 'node:fs/promises';
import { approvalsFileSchema } from '@monad/protocol';

const EMPTY: ApprovalsFile = { version: 1, global: [], agents: {} };

export class ApprovalStore {
  private data: ApprovalsFile = { version: 1, global: [], agents: {} };

  private constructor(private readonly filePath: string) {}

  /** Load from disk. Corrupt JSON / schema mismatch → empty set (fail-closed). */
  static async load(filePath: string): Promise<ApprovalStore> {
    const store = new ApprovalStore(filePath);
    try {
      const file = Bun.file(filePath);
      if (await file.exists()) {
        const parsed = approvalsFileSchema.safeParse(JSON.parse(await file.text()));
        store.data = parsed.success ? parsed.data : structuredClone(EMPTY);
      }
    } catch {
      store.data = structuredClone(EMPTY);
    }
    return store;
  }

  global(): ApprovalRule[] {
    return this.data.global;
  }

  forAgent(agentId: string): ApprovalRule[] {
    return this.data.agents[agentId] ?? [];
  }

  /** All persisted rules across global + every agent. */
  all(): ApprovalRule[] {
    return [...this.data.global, ...Object.values(this.data.agents).flat()];
  }

  async add(rule: ApprovalRule): Promise<void> {
    if (rule.scope === 'global') {
      this.data.global.push(rule);
    } else if (rule.scope === 'agent' && rule.agentId) {
      const bucket = this.data.agents[rule.agentId] ?? [];
      bucket.push(rule);
      this.data.agents[rule.agentId] = bucket;
    } else {
      return; // session/other scopes are not persisted here
    }
    await this.flush();
  }

  /** Remove a rule by id. Returns true if something was removed. */
  async remove(id: string): Promise<boolean> {
    let removed = false;
    const before = this.data.global.length;
    this.data.global = this.data.global.filter((r) => r.id !== id);
    removed ||= this.data.global.length !== before;
    for (const [agentId, rules] of Object.entries(this.data.agents)) {
      const filtered = rules.filter((r) => r.id !== id);
      if (filtered.length !== rules.length) {
        removed = true;
        if (filtered.length === 0) delete this.data.agents[agentId];
        else this.data.agents[agentId] = filtered;
      }
    }
    if (removed) await this.flush();
    return removed;
  }

  /** Bulk-remove by optional scope/agent filter. Returns the count removed. */
  async clear(filter: { scope?: 'global' | 'agent'; agentId?: string } = {}): Promise<number> {
    let removed = 0;
    if (!filter.scope || filter.scope === 'global') {
      if (!filter.agentId) {
        removed += this.data.global.length;
        this.data.global = [];
      }
    }
    if (!filter.scope || filter.scope === 'agent') {
      for (const [agentId, rules] of Object.entries(this.data.agents)) {
        if (filter.agentId && agentId !== filter.agentId) continue;
        removed += rules.length;
        delete this.data.agents[agentId];
      }
    }
    if (removed) await this.flush();
    return removed;
  }

  private async flush(): Promise<void> {
    const tmp = `${this.filePath}.tmp`;
    await Bun.write(tmp, `${JSON.stringify(this.data, null, 2)}\n`);
    if (process.platform === 'win32') {
      try {
        const { unlink } = await import('node:fs/promises');
        await unlink(this.filePath);
      } catch {
        /* target may not exist yet */
      }
    }
    await rename(tmp, this.filePath);
    if (process.platform !== 'win32') await chmod(this.filePath, 0o600);
  }
}
