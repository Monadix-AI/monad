import { describe, expect, test } from 'bun:test';
import { Readable } from 'node:stream';

import {
  type CredentialRedaction,
  CredentialRedactionStream,
  ProtectedResponseBudget,
  redactCredentialBytes
} from '../../src/credential-redaction-stream.ts';

const secret = 'credential-canary-秘密';
const sentinel = 'fake_value_execution_only';
const redactions: readonly CredentialRedaction[] = [{ secret, sentinel }];

async function redact(chunks: readonly Buffer[]): Promise<Buffer> {
  const output: Buffer[] = [];
  for await (const chunk of Readable.from(chunks).pipe(new CredentialRedactionStream(redactions))) {
    output.push(Buffer.from(chunk));
  }
  return Buffer.concat(output);
}

describe('CredentialRedactionStream', () => {
  test('replaces a reflected credential in one response body chunk', async () => {
    const output = await redact([Buffer.from(`before:${secret}:after`)]);
    expect(output.toString('utf8')).toBe(`before:${sentinel}:after`);
  });

  test('replaces a reflected credential at every possible two-chunk split point', async () => {
    const bytes = Buffer.from(secret);
    const outputs = await Promise.all(
      Array.from({ length: bytes.length - 1 }, (_, index) =>
        redact([bytes.subarray(0, index + 1), bytes.subarray(index + 1)])
      )
    );
    expect(outputs.map((output) => output.toString('utf8'))).toEqual(
      Array.from({ length: bytes.length - 1 }, () => sentinel)
    );
  });

  test('replaces adjacent and repeated reflected credentials without leaving fragments', async () => {
    const output = await redact([
      Buffer.from(secret),
      Buffer.from(`${secret}:`),
      Buffer.from(secret),
      Buffer.from(secret)
    ]);
    expect(output.toString('utf8')).toBe(`${sentinel}${sentinel}:${sentinel}${sentinel}`);
  });

  test('keeps arbitrary non-matching binary bytes byte-for-byte without decoding them', async () => {
    const binary = Buffer.from([0xff, 0x00, 0xc0, 0xaf, 0x80, 0x01]);
    const output = await redact([binary.subarray(0, 2), binary.subarray(2)]);
    expect(output).toEqual(binary);
  });

  test('redacts headers with the same adjacent-match semantics', () => {
    const output = redactCredentialBytes(Buffer.from(`Bearer ${secret}${secret}`), redactions);
    expect(output.toString('utf8')).toBe(`Bearer ${sentinel}${sentinel}`);
  });

  test('fails before expanding a one-byte secret beyond the protected output cap', () => {
    const input = Buffer.alloc(1024 * 1024, 0x61);
    expect(() =>
      redactCredentialBytes(input, [{ secret: 'a', sentinel: 'fake_value_00000000-0000-4000-8000-000000000000' }], {
        maxOutputBytes: 1024 * 1024
      })
    ).toThrow('credential_redaction_output_too_large');
  });

  test('execution response budget allows only bounded concurrent reservations and releases exactly once', () => {
    const budget = new ProtectedResponseBudget(4 * 1024 * 1024);
    const first = budget.reserve(4 * 1024 * 1024);
    const second = budget.reserve(1);
    first?.();
    first?.();
    const third = budget.reserve(4 * 1024 * 1024);
    expect({ first: typeof first, second, third: typeof third, reservedBytes: budget.reservedBytes }).toEqual({
      first: 'function',
      second: undefined,
      third: 'function',
      reservedBytes: 4 * 1024 * 1024
    });
    third?.();
    budget.close();
    expect({ afterRelease: budget.reservedBytes, afterClose: budget.reserve(1) }).toEqual({
      afterRelease: 0,
      afterClose: undefined
    });
  });
});
