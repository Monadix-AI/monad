import type { HostPlatformModule, HostPlatformUtils } from './host-platform-contract.ts';

const OSASCRIPT_SOURCE = [
  'on run argv',
  'set thePrompt to item 1 of argv',
  'if (count of argv) > 1 then',
  'return POSIX path of (choose folder with prompt thePrompt default location (POSIX file (item 2 of argv)))',
  'end if',
  'return POSIX path of (choose folder with prompt thePrompt)',
  'end run'
].join('\n');

const hostPlatformUtils: HostPlatformUtils = {
  platform: 'darwin',
  directoryPickerSpecs(options = {}) {
    const prompt = options.prompt ?? 'Choose a folder';
    const defaultPath = options.defaultPath?.trim() || undefined;
    return [{ argv: ['osascript', '-e', OSASCRIPT_SOURCE, prompt, ...(defaultPath ? [defaultPath] : [])] }];
  },
  openUrlCommand(url) {
    return { argv: ['open', url] };
  },
  openPathCommands(path, mode = 'open') {
    return mode === 'reveal' ? [{ argv: ['open', '-R', path] }] : [{ argv: ['open', path] }];
  }
};

export const hostPlatformModule: HostPlatformModule = {
  current: hostPlatformUtils,
  forPlatform(platform) {
    if (platform !== 'darwin') throw new Error(`Darwin host platform cannot serve ${platform}`);
    return hostPlatformUtils;
  }
};
