import type { MonadAuth, MonadConfig } from '@monad/home';

export type ConfigEvent = { cfg: MonadConfig; auth: MonadAuth | null };
type Listener = (event: ConfigEvent) => void | Promise<void>;

/**
 * In-process pub/sub for config/profile changes.
 *
 * publish() awaits all listeners so callers can be sure in-memory state
 * is consistent before returning a response. Errors in individual listeners
 * are caught and forwarded to the error handler (never propagated to the caller).
 */
export class ConfigBus {
  private readonly listeners = new Set<Listener>();
  private readonly onError: (err: unknown) => void;

  constructor(
    onError: (err: unknown) => void = () => {},
    private readonly requestReload?: (event: ConfigEvent) => Promise<void>
  ) {
    this.onError = onError;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async publish(event: ConfigEvent): Promise<void> {
    if (this.requestReload) return this.requestReload(event);
    await this.deliver(event);
  }

  async deliver(event: ConfigEvent): Promise<void> {
    await Promise.all([...this.listeners].map((fn) => Promise.resolve(fn(event)).catch((err) => this.onError(err))));
  }
}
