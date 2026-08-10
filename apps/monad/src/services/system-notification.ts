import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface SystemNotification {
  title: string;
  subtitle?: string;
  body: string;
  actionUrl?: string;
}

export interface SystemNotificationCommand {
  argv: string[];
  env?: Record<string, string>;
}

const MACOS_NOTIFICATION_SOURCE = `on run argv
  display notification (item 3 of argv) with title (item 1 of argv) subtitle (item 2 of argv)
end run`;

const WINDOWS_NOTIFICATION_SOURCE = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$title = [System.Security.SecurityElement]::Escape($env:MONAD_NOTIFICATION_TITLE)
$subtitle = [System.Security.SecurityElement]::Escape($env:MONAD_NOTIFICATION_SUBTITLE)
$body = [System.Security.SecurityElement]::Escape($env:MONAD_NOTIFICATION_BODY)
$actionUrl = [System.Security.SecurityElement]::Escape($env:MONAD_NOTIFICATION_ACTION_URL)
$activation = if ($actionUrl) { " activationType='protocol' launch='$actionUrl'" } else { '' }
$image = ''
if ($env:MONAD_NOTIFICATION_ICON -and (Test-Path -LiteralPath $env:MONAD_NOTIFICATION_ICON)) {
  $iconUri = [System.Security.SecurityElement]::Escape(([Uri]::new($env:MONAD_NOTIFICATION_ICON)).AbsoluteUri)
  $image = "<image placement='appLogoOverride' src='$iconUri'/>"
}
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast$activation><visual><binding template='ToastGeneric'>$image<text>$title</text><text>$subtitle</text><text>$body</text></binding></visual></toast>")
$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('ai.monad.app').Show($toast)
`;

export function systemNotificationCommand(
  platform: NodeJS.Platform,
  notification: SystemNotification,
  options: {
    executablePath?: string;
    notificationAppPath?: string;
    notificationIconPath?: string;
    pathExists?: (path: string) => boolean;
    linuxActions?: boolean;
  } = {}
): SystemNotificationCommand | null {
  const pathExists = options.pathExists ?? existsSync;
  const executablePath = options.executablePath ?? process.execPath;
  const iconPath = options.notificationIconPath ?? join(dirname(executablePath), 'assets', 'monad-icon-1024.png');
  if (platform === 'darwin') {
    const appPath = options.notificationAppPath ?? join(dirname(executablePath), 'helpers', 'Monad.app');
    if (pathExists(appPath)) {
      return {
        argv: [
          'open',
          '-g',
          '-j',
          '-n',
          appPath,
          '--args',
          '--notify',
          '--title',
          notification.title,
          '--subtitle',
          notification.subtitle ?? '',
          '--body',
          notification.body,
          ...(notification.actionUrl ? ['--action-url', notification.actionUrl] : [])
        ]
      };
    }
    return {
      argv: [
        'osascript',
        '-e',
        MACOS_NOTIFICATION_SOURCE,
        notification.title,
        notification.subtitle ?? '',
        notification.body
      ]
    };
  }
  if (platform === 'linux') {
    const body = notification.subtitle ? `${notification.subtitle}\n${notification.body}` : notification.body;
    return {
      argv: [
        'notify-send',
        '--app-name=Monad',
        '--hint=string:desktop-entry:monad',
        ...(pathExists(iconPath) ? ['--icon', iconPath] : []),
        ...(notification.actionUrl && options.linuxActions !== false ? ['--action=default=Open', '--wait'] : []),
        notification.title,
        body
      ]
    };
  }
  if (platform === 'win32') {
    return {
      argv: ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_NOTIFICATION_SOURCE],
      env: {
        MONAD_NOTIFICATION_TITLE: notification.title,
        MONAD_NOTIFICATION_SUBTITLE: notification.subtitle ?? '',
        MONAD_NOTIFICATION_BODY: notification.body,
        ...(notification.actionUrl ? { MONAD_NOTIFICATION_ACTION_URL: notification.actionUrl } : {}),
        ...(pathExists(iconPath) ? { MONAD_NOTIFICATION_ICON: iconPath } : {})
      }
    };
  }
  return null;
}

export async function sendSystemNotification(
  notification: SystemNotification,
  platform: NodeJS.Platform = process.platform
): Promise<boolean> {
  const command = systemNotificationCommand(platform, notification);
  if (!command) return false;
  if (platform === 'linux' && notification.actionUrl) {
    try {
      const proc = Bun.spawn(command.argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
      const [selectedAction, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      if (exitCode === 0) {
        if (selectedAction.trim() === 'default') {
          Bun.spawn(['xdg-open', notification.actionUrl], {
            stdin: 'ignore',
            stdout: 'ignore',
            stderr: 'ignore'
          }).unref();
        }
        return true;
      }
    } catch {
      /* retry below without actions for older notify-send implementations */
    }
    const fallback = systemNotificationCommand(platform, notification, { linuxActions: false });
    return fallback ? runNotificationCommand(fallback) : false;
  }
  return runNotificationCommand(command);
}

async function runNotificationCommand(command: SystemNotificationCommand): Promise<boolean> {
  try {
    const proc = Bun.spawn(command.argv, {
      env: command.env ? { ...Bun.env, ...command.env } : undefined,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore'
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}
