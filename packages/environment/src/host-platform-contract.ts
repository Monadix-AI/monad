type HostPlatform = 'darwin' | 'linux' | 'win32';
export type NativeOpenMode = 'open' | 'reveal';

export interface HostCommand {
  argv: string[];
  env?: Record<string, string>;
}

export interface PickDirectoryOptions {
  prompt?: string;
  defaultPath?: string;
}

export interface HostPlatformUtils {
  platform: HostPlatform;
  directoryPickerSpecs(options?: PickDirectoryOptions): readonly HostCommand[];
  openUrlCommand(url: string): HostCommand;
  openPathCommands(path: string, mode?: NativeOpenMode): readonly HostCommand[];
}

export interface HostPlatformModule {
  current: HostPlatformUtils;
  forPlatform(platform: NodeJS.Platform): HostPlatformUtils;
}
