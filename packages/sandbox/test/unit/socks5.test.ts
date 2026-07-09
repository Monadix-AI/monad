import { afterEach, expect, test } from 'bun:test';
import { startEgressProxy } from '@monad/sandbox';

// Drive the muxed egress proxy with a RAW SOCKS5 client (Bun.connect + hand-written wire bytes). The
// proxy's SOCKS5 leg must gate exactly like the HTTP leg, relay bytes end to end on allow, and refuse
// with REP 0x02 on deny — and the mux must not disturb the HTTP path.

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const allowAll = { policy: { allowedDomains: ['*'] }, isAllowed: () => true, assertDialable: async () => {} };

/** A localhost TCP echo server; resolves once listening. Returns its port + a stop() for cleanup. */
function startEcho(): { port: number; stop: () => void } {
  const echo = Bun.listen<undefined>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data: (s, d) => {
        s.write(d);
      },
      open: () => {}
    }
  });
  return { port: echo.port, stop: () => echo.stop(true) };
}

/** Build a SOCKS5 no-auth CONNECT to 127.0.0.1:<port> (greeting + request concatenated). */
function socks5ConnectIpv4(port: number): Uint8Array {
  const greeting = [0x05, 0x01, 0x00]; // VER, NMETHODS=1, no-auth
  const request = [0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, (port >> 8) & 0xff, port & 0xff];
  return new Uint8Array([...greeting, ...request]);
}

/** Build a SOCKS5 no-auth CONNECT to a raw DOMAINNAME (ATYP 0x03), byte-for-byte — lets a test send
 *  bytes (e.g. an embedded NUL) that a JS `string` literal for the host couldn't carry cleanly. */
function socks5ConnectDomainRaw(hostBytes: number[], port: number): Uint8Array {
  const greeting = [0x05, 0x01, 0x00];
  const request = [0x05, 0x01, 0x00, 0x03, hostBytes.length, ...hostBytes, (port >> 8) & 0xff, port & 0xff];
  return new Uint8Array([...greeting, ...request]);
}

/**
 * Connect to the mux `port`, run a caller-supplied script against the socket, and resolve with the
 * accumulated response bytes once `until` matches. The script gets (socket, latestText) on each data
 * event so it can send follow-up bytes after the SOCKS reply.
 */
function driveRaw(
  port: number,
  onOpen: (write: (b: Uint8Array | string) => void) => void,
  onData: (text: string, bytes: Buffer, write: (b: Uint8Array | string) => void) => void,
  until: (bytes: Buffer) => boolean
): Promise<Buffer> {
  const got: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    Bun.connect<undefined>({
      hostname: '127.0.0.1',
      port,
      socket: {
        open: (s) => onOpen((b) => s.write(b)),
        data: (s, d) => {
          got.push(Buffer.from(d));
          const all = Buffer.concat(got);
          onData(all.toString('latin1'), all, (b) => s.write(b));
          if (until(all)) {
            resolve(all);
            s.end();
          }
        },
        error: (_s, e) => reject(e)
      }
    }).catch(reject);
  });
}

test('SOCKS5: an allowed CONNECT succeeds (REP 0x00) and relays bytes end to end', async () => {
  const echo = startEcho();
  const proxy = startEgressProxy(allowAll);
  cleanups.push(echo.stop, () => proxy.stop());

  // Reply layout: greeting reply (2 bytes: 0x05 0x00), then request reply (10 bytes, REP at offset
  // 3), then the echoed payload. Send PING once the 12-byte reply prefix (with REP=succeeded) lands.
  let sentPayload = false;
  const bytes = await driveRaw(
    proxy.port,
    (write) => write(socks5ConnectIpv4(echo.port)),
    (_text, all, write) => {
      if (!sentPayload && all.length >= 12 && all[3] === 0x00) {
        sentPayload = true;
        write('PING');
      }
    },
    (all) => all.length >= 12 && all[3] === 0x00 && all.subarray(12).toString('latin1').includes('PING')
  );

  expect(bytes[2]).toBe(0x05); // request reply VER
  expect(bytes[3]).toBe(0x00); // REP: succeeded
  expect(bytes.subarray(12).toString('latin1')).toBe('PING');
});

test('SOCKS5: a denied CONNECT gets REP 0x02 and no upstream connection is made', async () => {
  let upstreamHits = 0;
  const echo = Bun.listen<undefined>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open: () => {
        upstreamHits++;
      },
      data: () => {}
    }
  });
  const proxy = startEgressProxy({ policy: { allowedDomains: [] }, isAllowed: () => false });
  cleanups.push(
    () => echo.stop(true),
    () => proxy.stop()
  );

  // The reply arrives in two parts: the 2-byte greeting reply (0x05 0x00 = no-auth selected), then
  // the 10-byte request reply carrying REP at offset 2 of that block (absolute offset 3).
  const bytes = await driveRaw(
    proxy.port,
    (write) => write(socks5ConnectIpv4(echo.port)),
    () => {},
    (all) => all.length >= 12
  );

  expect(bytes[2]).toBe(0x05); // request reply VER
  expect(bytes[3]).toBe(0x02); // REP: connection not allowed by ruleset
  expect(upstreamHits).toBe(0);
});

test('SOCKS4: rejected cleanly (VN 0x00, CD 0x5b) without an upstream dial', async () => {
  const proxy = startEgressProxy(allowAll);
  cleanups.push(() => proxy.stop());

  // SOCKS4 CONNECT: VN=0x04, CD=0x01, DSTPORT, DSTIP, USERID\0.
  const socks4 = new Uint8Array([0x04, 0x01, 0x00, 0x50, 127, 0, 0, 1, 0x00]);
  const bytes = await driveRaw(
    proxy.port,
    (write) => write(socks4),
    () => {},
    (all) => all.length >= 2
  );

  expect(bytes[0]).toBe(0x00);
  expect(bytes[1]).toBe(0x5b); // request rejected/failed
});

test(
  'attack: NUL-byte hostname smuggling (parser-differential SOCKS5 allowlist bypass) is refused, ' +
    'never dialed — an attacker sends "evil.com\\x00.allowed.com" hoping a JS endsWith() check on ' +
    'the truncated-at-write side sees ".allowed.com" while a libc-style resolver would truncate at ' +
    'the NUL and dial "evil.com" (this exact allowlist bypass was reported against sandbox-runtime); ' +
    'isValidHost must reject any control byte in the DOMAINNAME outright, before isAllowed ever runs',
  async () => {
    let upstreamHits = 0;
    let isAllowedCalls = 0;
    const echo = Bun.listen<undefined>({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        open: () => {
          upstreamHits++;
        },
        data: () => {}
      }
    });
    // isAllowed would (wrongly) approve on the suffix if it were ever reached — proves the rejection
    // happens at host-validation time, not because the allowlist itself denied it.
    const proxy = startEgressProxy({
      policy: { allowedDomains: ['allowed.com'] },
      isAllowed: (host) => {
        isAllowedCalls++;
        return host.endsWith('allowed.com');
      }
    });
    cleanups.push(
      () => echo.stop(true),
      () => proxy.stop()
    );

    const hostBytes = [...Buffer.from('evil.com'), 0x00, ...Buffer.from('.allowed.com')];
    const bytes = await driveRaw(
      proxy.port,
      (write) => write(socks5ConnectDomainRaw(hostBytes, echo.port)),
      () => {},
      (all) => all.length >= 12
    );

    expect(bytes[2]).toBe(0x05);
    expect(bytes[3]).toBe(0x02); // REP: not allowed — rejected as malformed, not evaluated as a host
    expect(upstreamHits).toBe(0); // "evil.com" was never dialed
    expect(isAllowedCalls).toBe(0); // never reached the allowlist — killed at host validation
  }
);

test('mux: a plain HTTP request on the same port still reaches the origin', async () => {
  const origin = Bun.serve({ port: 0, fetch: () => new Response('hello-from-origin') });
  const proxy = startEgressProxy(allowAll);
  cleanups.push(
    () => origin.stop(true),
    () => proxy.stop()
  );

  const bytes = await driveRaw(
    proxy.port,
    (write) => write(`GET http://127.0.0.1:${origin.port}/x HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`),
    () => {},
    (all) => all.toString('latin1').includes('hello-from-origin')
  );
  expect(bytes.toString('latin1')).toContain('hello-from-origin');
});
