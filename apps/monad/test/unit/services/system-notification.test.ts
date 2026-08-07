import { expect, test } from 'bun:test';

import { systemNotificationCommand } from '#/services/system-notification.ts';

const notification = {
  title: 'Monad Update Available',
  subtitle: 'Version 2.0.0',
  body: 'A new version of Monad is ready.',
  actionUrl: 'http://127.0.0.1:3000/settings/system'
};

test('packaged macOS notification launches the native Monad app with its content and click target', () => {
  const appPath = '/opt/monad/helpers/Monad.app';
  const command = systemNotificationCommand('darwin', notification, {
    notificationAppPath: appPath,
    pathExists: () => true
  });

  expect(command).toEqual({
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
      notification.subtitle,
      '--body',
      notification.body,
      '--action-url',
      notification.actionUrl
    ]
  });
});

test('development macOS notification falls back to safe AppleScript argv', () => {
  const command = systemNotificationCommand('darwin', notification, { pathExists: () => false });

  expect(command?.argv.slice(0, 3)).toEqual(['osascript', '-e', expect.any(String)]);
  expect(command?.argv.slice(3)).toEqual([notification.title, notification.subtitle, notification.body]);
  expect(command?.argv[2]).not.toContain(notification.body);
});

test('Linux notification uses notify-send with a Monad application name', () => {
  const iconPath = '/opt/monad/assets/monad-icon-1024.png';
  expect(
    systemNotificationCommand('linux', notification, {
      notificationIconPath: iconPath,
      pathExists: () => true
    })
  ).toEqual({
    argv: [
      'notify-send',
      '--app-name=Monad',
      '--hint=string:desktop-entry:monad',
      '--icon',
      iconPath,
      '--action=default=Open',
      '--wait',
      notification.title,
      `${notification.subtitle}\n${notification.body}`
    ]
  });
});

test('Linux notification can degrade to an icon-only notification when actions are unsupported', () => {
  expect(
    systemNotificationCommand('linux', notification, {
      linuxActions: false,
      pathExists: () => false
    })?.argv
  ).toEqual([
    'notify-send',
    '--app-name=Monad',
    '--hint=string:desktop-entry:monad',
    notification.title,
    `${notification.subtitle}\n${notification.body}`
  ]);
});

test('Windows notification passes user-visible text through environment variables', () => {
  const iconPath = 'C:\\Monad\\assets\\monad-icon-1024.png';
  const command = systemNotificationCommand('win32', notification, {
    notificationIconPath: iconPath,
    pathExists: () => true
  });

  expect(command?.argv.slice(0, 4)).toEqual(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command']);
  expect(command?.argv.join(' ')).not.toContain(notification.body);
  expect(command?.argv[4]).toContain("CreateToastNotifier('ai.monad.app')");
  expect(command?.argv[4]).toContain("activationType='protocol'");
  expect(command?.env).toEqual({
    MONAD_NOTIFICATION_TITLE: notification.title,
    MONAD_NOTIFICATION_SUBTITLE: notification.subtitle,
    MONAD_NOTIFICATION_BODY: notification.body,
    MONAD_NOTIFICATION_ACTION_URL: notification.actionUrl,
    MONAD_NOTIFICATION_ICON: iconPath
  });
});

test('unsupported platforms do not produce a notification command', () => {
  expect(systemNotificationCommand('freebsd', notification)).toBeNull();
});
