export function realVmAdmission(
  envValue: string | undefined,
  platform: NodeJS.Platform = process.platform
): 'run' | 'skip' {
  if (envValue !== '1') return 'skip';
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32') return 'run';
  throw new Error(`sandbox-vm real integration is unsupported on ${platform}`);
}
