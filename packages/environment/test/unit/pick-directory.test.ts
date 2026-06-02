import { describe, expect, test } from 'bun:test';

import { directoryPickerSpecs } from '../../src/pick-directory.ts';

describe('directoryPickerSpecs', () => {
  test('macOS passes prompt + default path as osascript argv (not interpolated into the script)', () => {
    const specs = directoryPickerSpecs('darwin', { prompt: 'Pick a folder', defaultPath: '/Users/me/proj' });
    expect(specs).toHaveLength(1);
    const [spec] = specs;
    expect(spec?.argv[0]).toBe('osascript');
    // The trailing args are the prompt and default path — argv elements, so quotes/newlines can't inject.
    expect(spec?.argv.at(-2)).toBe('Pick a folder');
    expect(spec?.argv.at(-1)).toBe('/Users/me/proj');
    expect(spec?.argv).toContain('-e');
  });

  test('macOS omits the default-location arg when no default path is given', () => {
    const [spec] = directoryPickerSpecs('darwin', { prompt: 'Pick' });
    expect(spec?.argv.at(-1)).toBe('Pick');
    expect(spec?.argv).toHaveLength(4); // osascript, -e, <script>, prompt
  });

  test('Windows passes prompt + default via env, never the static PowerShell source', () => {
    const specs = directoryPickerSpecs('win32', { prompt: 'Choose', defaultPath: 'C:\\work' });
    // powershell.exe first, pwsh (PowerShell 7) as a fallback.
    expect(specs.map((s) => s.argv[0])).toEqual(['powershell', 'pwsh']);
    for (const spec of specs) {
      expect(spec.env).toEqual({ MONAD_PICK_PROMPT: 'Choose', MONAD_PICK_DEFAULT: 'C:\\work' });
      expect(spec.argv.join(' ')).not.toContain('Choose');
    }
  });

  test('Linux falls back from zenity to kdialog', () => {
    const specs = directoryPickerSpecs('linux', { prompt: 'Folder', defaultPath: '/home/me' });
    expect(specs.map((s) => s.argv[0])).toEqual(['zenity', 'kdialog']);
    // zenity wants a trailing slash on --filename to land inside the directory.
    expect(specs[0]?.argv).toContain('/home/me/');
  });

  test('empty/whitespace default path is treated as absent', () => {
    const [spec] = directoryPickerSpecs('darwin', { prompt: 'Pick', defaultPath: '   ' });
    expect(spec?.argv).toHaveLength(4);
  });
});
