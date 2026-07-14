import { describe, expect, test } from 'bun:test';

import {
  enqueueFollowUp,
  filterByTitle,
  mergeById,
  safeErrorMessage,
  transcriptWindow
} from '../../src/shell/view-model.ts';

describe('transcriptWindow', () => {
  test('pages backward from the live tail without crossing the first message', () => {
    const messages = Array.from({ length: 8 }, (_, id) => ({ id }));

    expect(transcriptWindow(messages, 3, 0).map((item) => item.id)).toEqual([5, 6, 7]);
    expect(transcriptWindow(messages, 3, 2).map((item) => item.id)).toEqual([3, 4, 5]);
    expect(transcriptWindow(messages, 3, 99).map((item) => item.id)).toEqual([0, 1, 2]);
  });
});

describe('safeErrorMessage', () => {
  test('does not invoke hostile object coercion hooks', () => {
    const error = { message: 'request failed', [Symbol.toPrimitive]: () => ({}) };
    expect(safeErrorMessage(error)).toBe('request failed');
  });
});

describe('filterByTitle', () => {
  test('matches case-insensitively and preserves source order', () => {
    const items = [{ title: 'Alpha' }, { title: 'beta chat' }, { title: 'Alphabet' }];
    expect(filterByTitle(items, 'ALP')).toEqual([{ title: 'Alpha' }, { title: 'Alphabet' }]);
  });
});

describe('mergeById', () => {
  test('deduplicates history and lets the live frame replace matching events', () => {
    const history = [
      { id: 'a', text: 'old a' },
      { id: 'b', text: 'old b' }
    ];
    const live = [
      { id: 'b', text: 'live b' },
      { id: 'c', text: 'live c' }
    ];
    expect(mergeById(history, live)).toEqual([
      { id: 'a', text: 'old a' },
      { id: 'b', text: 'live b' },
      { id: 'c', text: 'live c' }
    ]);
  });
});

describe('enqueueFollowUp', () => {
  test('trims and ignores empty follow-ups', () => {
    expect(enqueueFollowUp(['first'], '  second  ')).toEqual(['first', 'second']);
    expect(enqueueFollowUp(['first'], '  ')).toEqual(['first']);
  });
});
