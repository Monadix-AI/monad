import { expect, test } from 'bun:test';

import { formatMemoryDownloadProgress, MEMORY_TABS, mem0Activation } from './memory-settings-state';

test('mem0 activation confirms only when the managed dependency is missing', () => {
  expect(mem0Activation(undefined)).toBe('activate');
  expect(mem0Activation({ installed: true })).toBe('activate');
  expect(mem0Activation({ installed: false })).toBe('confirm');
});

test('Memory navigation exposes all shared content views', () => {
  expect(MEMORY_TABS).toEqual(['settings', 'facts', 'graph', 'laws']);
});

test('download progress is determinate only when a positive total is known', () => {
  expect(formatMemoryDownloadProgress(5, 10)).toEqual({
    loaded: '5 B',
    total: '10 B',
    percent: 50
  });
  expect(formatMemoryDownloadProgress(1536, null)).toEqual({
    loaded: '1.5 KB',
    total: null,
    percent: null
  });
});
