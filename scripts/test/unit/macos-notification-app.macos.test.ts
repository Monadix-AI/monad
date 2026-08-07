import { expect, test } from 'bun:test';

import {
  MACOS_NOTIFICATION_APP_RELATIVE_PATH,
  macOSNotificationTarget,
  renderMacOSNotificationInfoPlist
} from '../../lib/macos-notification-app.ts';

test('macOS notification app has a stable packaged location and architecture targets', () => {
  expect(MACOS_NOTIFICATION_APP_RELATIVE_PATH).toBe('helpers/Monad.app');
  expect(macOSNotificationTarget('arm64')).toBe('arm64-apple-macosx13.0');
  expect(macOSNotificationTarget('x64')).toBe('x86_64-apple-macosx13.0');
});

test('macOS notification app plist carries Monad identity, icon, and background-agent policy', () => {
  const plist = renderMacOSNotificationInfoPlist();

  expect(plist).toContain('<string>ai.monad.notifier</string>');
  expect(plist).toContain('<string>Monad</string>');
  expect(plist).toContain('<string>MonadIcon</string>');
  expect(plist).toContain('<key>LSUIElement</key>\n  <true/>');
});
