import type { HostPlatformModule, HostPlatformUtils } from './host-platform-contract.ts';

const hostPlatformUtils: HostPlatformUtils = {
  platform: 'linux',
  directoryPickerSpecs(options = {}) {
    const prompt = options.prompt ?? 'Choose a folder';
    const defaultPath = options.defaultPath?.trim() || undefined;
    return [
      {
        argv: [
          'zenity',
          '--file-selection',
          '--directory',
          '--title',
          prompt,
          ...(defaultPath ? ['--filename', defaultPath.endsWith('/') ? defaultPath : `${defaultPath}/`] : [])
        ]
      },
      { argv: ['kdialog', '--getexistingdirectory', defaultPath ?? '.', '--title', prompt] }
    ];
  },
  openUrlCommand(url) {
    return { argv: ['xdg-open', url] };
  },
  openPathCommands(path) {
    return [{ argv: ['xdg-open', path] }];
  }
};

export const hostPlatformModule: HostPlatformModule = {
  current: hostPlatformUtils,
  forPlatform(platform) {
    if (platform !== 'linux') throw new Error(`Linux host platform cannot serve ${platform}`);
    return hostPlatformUtils;
  }
};
