type Cleanup = () => void | Promise<void>;

export class BootTransaction {
  private cleanups: Cleanup[] = [];
  private state: 'open' | 'committed' | 'rolled-back' = 'open';

  defer(cleanup: Cleanup): void {
    if (this.state !== 'open') throw new Error(`boot transaction is already ${this.state}`);
    this.cleanups.push(cleanup);
  }

  commit(): void {
    if (this.state !== 'open') throw new Error(`boot transaction is already ${this.state}`);
    this.state = 'committed';
    this.cleanups = [];
  }

  async rollback(_cause: unknown): Promise<void> {
    if (this.state !== 'open') return;
    this.state = 'rolled-back';
    const cleanups = this.cleanups.reverse();
    this.cleanups = [];
    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch {}
    }
  }
}
