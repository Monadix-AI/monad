import type { StartupPlatform, StartupPlatformModule } from './startup-platform-contract.ts';

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { quoteDesktop, quoteShell, startupIconPath } from './startup-platform-common.ts';

const platform: StartupPlatform = {
  platform: 'linux',
  target({ homeDir, identity }) {
    return { path: join(homeDir, '.config', 'autostart', `${identity.slug}.desktop`), mode: 0o644 };
  },
  legacyTargets({ homeDir, identity }) {
    return identity.slug === 'monad-dev' ? [join(homeDir, '.config', 'autostart', 'monad.desktop')] : [];
  },
  registrar() {
    return null;
  },
  async write(target, context) {
    await mkdir(dirname(target.path), { recursive: true });
    const shellCommand = `MONAD_HOME=${quoteShell(context.monadHome)} exec ${context.command.map(quoteShell).join(' ')} >> ${quoteShell(context.logPath)} 2>&1`;
    const content = `[Desktop Entry]
Type=Application
Name=${context.identity.name}
Comment=Start the Monad daemon at login
Exec=/bin/sh -lc ${quoteDesktop(shellCommand)}
Icon=${startupIconPath('linux', context.command)}
Terminal=false
X-GNOME-Autostart-enabled=true
`;
    await writeFile(target.path, content, { mode: target.mode });
  }
};

export const startupPlatformModule: StartupPlatformModule = {
  current: platform,
  forPlatform(value) {
    return value === 'linux' ? platform : null;
  }
};
