import { describe, expect, test } from 'bun:test';

import { decodeRawUpload, decodeRawUploads } from '@/services/upload.ts';

const bytes = (value: string) => new TextEncoder().encode(value);

describe('upload service utilities', () => {
  test('decodeRawUpload decodes one payload', () => {
    const upload = decodeRawUpload({ filename: 'note.md', bytes: bytes('hello') });

    expect(upload.filename).toBe('note.md');
    expect(upload.extension).toBe('.md');
    expect(upload.text()).toBe('hello');
  });

  test('decodeRawUpload rejects filenames with path separators', () => {
    expect(() => decodeRawUpload({ filename: 'dir/note.md', bytes: bytes('hello') })).toThrow(
      'upload filename must not contain path separators'
    );
    expect(() => decodeRawUpload({ filename: 'dir\\note.md', bytes: bytes('hello') })).toThrow(
      'upload filename must not contain path separators'
    );
  });

  test('decodeRawUploads rejects duplicate filenames in one batch', () => {
    expect(() =>
      decodeRawUploads([
        { filename: 'same.md', bytes: bytes('one') },
        { filename: 'same.md', bytes: bytes('two') }
      ])
    ).toThrow('duplicate upload filename: same.md');
  });

  test('decodeRawUploads accepts distinct filenames', () => {
    const uploads = decodeRawUploads([
      { filename: 'one.md', bytes: bytes('one') },
      { filename: 'two.md', bytes: bytes('two') }
    ]);

    expect(uploads.map((upload) => upload.text())).toEqual(['one', 'two']);
  });
});
