import type { ConfigSnapshot } from './manager.ts';

type ReloadTarget = (snapshot: ConfigSnapshot) => Promise<void>;

const idle: ReloadTarget = async () => {};

export class ConfigReloadTargets {
  private application: ReloadTarget = idle;
  private network: ReloadTarget = idle;

  setApplication(target: ReloadTarget): void {
    this.application = target;
  }

  setNetwork(target: ReloadTarget): void {
    this.network = target;
  }

  async apply(snapshot: ConfigSnapshot): Promise<void> {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => this.application(snapshot)),
      Promise.resolve().then(() => this.network(snapshot))
    ]);
    const failures = results.flatMap((result, index) =>
      result.status === 'rejected'
        ? [
            {
              error: result.reason,
              message: `${index === 0 ? 'application' : 'network'} config reload failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
            }
          ]
        : []
    );
    if (failures.length) {
      throw new AggregateError(
        failures.map((failure) => failure.error),
        failures.map((failure) => failure.message).join('; ')
      );
    }
  }
}
