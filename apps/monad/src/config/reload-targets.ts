import type { ConfigSnapshot } from './service.ts';

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
    await this.application(snapshot);
    await this.network(snapshot);
  }
}
