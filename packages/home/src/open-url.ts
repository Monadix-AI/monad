import { hostPlatformModule } from './host-platform.ts';

/** Launch the default browser at `url`, detached. Returns false if no opener is available. */
export function openUrl(url: string): boolean {
  try {
    const command = hostPlatformModule.current.openUrlCommand(url);
    Bun.spawn(command.argv, {
      env: { ...Bun.env, ...(command.env ?? {}) },
      stdio: ['ignore', 'ignore', 'ignore']
    }).unref();
    return true;
  } catch {
    return false;
  }
}
