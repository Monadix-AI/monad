import type { HostPlatformModule, HostPlatformUtils } from './host-platform-contract.ts';

const POWERSHELL_PICKER_SOURCE = [
  'Add-Type -AssemblyName System.Windows.Forms;',
  '$d = New-Object System.Windows.Forms.FolderBrowserDialog;',
  '$d.Description = $env:MONAD_PICK_PROMPT;',
  'if ($env:MONAD_PICK_DEFAULT) { $d.SelectedPath = $env:MONAD_PICK_DEFAULT };',
  'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }'
].join(' ');

const hostPlatformUtils: HostPlatformUtils = {
  platform: 'win32',
  directoryPickerSpecs(options = {}) {
    const prompt = options.prompt ?? 'Choose a folder';
    const defaultPath = options.defaultPath?.trim() || undefined;
    const env = { MONAD_PICK_PROMPT: prompt, MONAD_PICK_DEFAULT: defaultPath ?? '' };
    return [
      { argv: ['powershell', '-NoProfile', '-STA', '-Command', POWERSHELL_PICKER_SOURCE], env },
      { argv: ['pwsh', '-NoProfile', '-STA', '-Command', POWERSHELL_PICKER_SOURCE], env }
    ];
  },
  openUrlCommand(url) {
    return {
      argv: [
        'powershell.exe',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Start-Process -FilePath $env:MONAD_OPEN_URL'
      ],
      env: { MONAD_OPEN_URL: url }
    };
  },
  openPathCommands(path, mode = 'open') {
    if (mode === 'reveal') return [{ argv: ['explorer.exe', '/select,', path] }];
    return [
      {
        argv: ['powershell.exe', '-NoProfile', '-Command', 'Start-Process -LiteralPath $env:MONAD_OPEN_PATH'],
        env: { MONAD_OPEN_PATH: path }
      }
    ];
  }
};

export const hostPlatformModule: HostPlatformModule = {
  current: hostPlatformUtils,
  forPlatform(platform) {
    if (platform !== 'win32') throw new Error(`Windows host platform cannot serve ${platform}`);
    return hostPlatformUtils;
  }
};
