// Minimal SOCKS5 CONNECT handler for the egress proxy's muxed listener. A confined child that
// honours ALL_PROXY (socks5h://…) routes non-HTTP TCP (ssh, db, git-ssh) through the SAME single
// proxy port, gated by the SAME allow + dialable checks as the HTTP path — so nothing is reachable
// over SOCKS that isn't reachable over HTTP. Only the no-auth CONNECT subset is implemented; BIND,
// UDP ASSOCIATE, and SOCKS4 are refused. See docs/security-guidelines.md §8.
//
// Wire refs: RFC 1928. Greeting `VER NMETHODS METHODS…`; request `VER CMD RSV ATYP ADDR PORT`.
//
// The client socket is owned by the muxed listener (a Bun `Socket<Conn>`); this module never reads
// its `.data`. All SOCKS state lives in the `Socks5Data` passed alongside, so the same physical
// socket can carry the mux's `Conn` bookkeeping. `ClientSocket` is the minimal write/end surface
// we need from it.

// SOCKS5 reply codes used here (field REP in the server reply).
const REP_SUCCEEDED = 0x00;
const REP_NOT_ALLOWED = 0x02; // connection not allowed by ruleset (denied host / SSRF)
const REP_REFUSED = 0x05; // connection refused (upstream dial failed)
const REP_CMD_NOT_SUPPORTED = 0x07;

const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;

interface ClientSocket {
  write(data: Uint8Array): number;
  end(): void;
}

interface UpstreamSocket {
  write(data: Uint8Array): number;
  end(): void;
}

export interface Socks5Data {
  phase: 'greeting' | 'request' | 'piping' | 'closed';
  buf: Buffer;
  upstream: UpstreamSocket | null;
  pending: Buffer[]; // client bytes seen before the upstream connects
}

export interface Socks5Deps {
  isAllowed: (host: string) => boolean;
  assertDialable: (host: string) => Promise<void>;
  log?: (message: string) => void;
}

/** Create the initial per-connection SOCKS5 state. */
export function initSocks5Data(): Socks5Data {
  return { phase: 'greeting', buf: Buffer.alloc(0), upstream: null, pending: [] };
}

// A SOCKS5 DOMAINNAME is a raw length-prefixed byte string with no protocol-level validation. Reject
// control chars (null, CR, LF) so a hostile name can't smuggle past the allowlist suffix matcher.
function isValidHost(host: string): boolean {
  if (host.length === 0 || host.length > 255) return false;
  for (let i = 0; i < host.length; i++) {
    const c = host.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

// Build the fixed SOCKS5 reply: `VER REP RSV ATYP BND.ADDR(4×0) BND.PORT(2×0)`. BND.ADDR/PORT are
// meaningless for CONNECT, so zeros are conventional and accepted by clients (curl, ssh -o, etc.).
function socks5Reply(rep: number): Buffer {
  return Buffer.from([0x05, rep, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0]);
}

/**
 * Feed a chunk of client bytes into the SOCKS5 machine. The muxed listener calls this for every
 * chunk on a SOCKS5 connection, including the first (with the 0x05 first byte already restored onto
 * `data.buf`). `client` is the Bun client socket; `data` is its SOCKS5 state.
 */
export function feedSocks5(client: ClientSocket, data: Socks5Data, chunk: Uint8Array, deps: Socks5Deps): void {
  if (data.phase === 'piping') {
    if (data.upstream) data.upstream.write(chunk);
    else data.pending.push(Buffer.from(chunk));
    return;
  }
  if (data.phase === 'closed') return;
  data.buf = Buffer.concat([data.buf, Buffer.from(chunk)]);
  if (data.phase === 'greeting') void advanceGreeting(client, data, deps);
  else if (data.phase === 'request') void advanceRequest(client, data, deps);
}

function endWith(client: ClientSocket, data: Socks5Data, reply: Buffer): void {
  data.phase = 'closed';
  client.write(reply);
  client.end();
}

// Read `phase` behind a boolean so TS doesn't narrow it away across an `await`: the client's close/
// error handler can flip it to 'closed' while we're mid-dial, and that re-check must survive.
function isClosed(data: Socks5Data): boolean {
  return data.phase === 'closed';
}

async function advanceGreeting(client: ClientSocket, data: Socks5Data, deps: Socks5Deps): Promise<void> {
  // Need VER(1) NMETHODS(1) before we know the full greeting length.
  if (data.buf.length < 2) return;
  if (data.buf[0] !== 0x05) {
    // Not SOCKS5 — the mux should never route it here, but fail closed rather than guess.
    data.phase = 'closed';
    client.end();
    return;
  }
  const nMethods = data.buf.readUInt8(1);
  if (data.buf.length < 2 + nMethods) return;
  const methods = data.buf.subarray(2, 2 + nMethods);
  const noAuthOffered = methods.includes(0x00);
  if (!noAuthOffered) {
    deps.log?.('socks5: no-auth method not offered');
    // 0xFF = no acceptable methods.
    endWith(client, data, Buffer.from([0x05, 0xff]));
    return;
  }
  client.write(Buffer.from([0x05, 0x00])); // select no-auth
  // Consume the greeting; the request may already be buffered behind it.
  data.buf = data.buf.subarray(2 + nMethods);
  data.phase = 'request';
  await advanceRequest(client, data, deps);
}

async function advanceRequest(client: ClientSocket, data: Socks5Data, deps: Socks5Deps): Promise<void> {
  // VER(1) CMD(1) RSV(1) ATYP(1) then a variable address.
  if (data.buf.length < 4) return;
  if (data.buf[0] !== 0x05) {
    endWith(client, data, socks5Reply(REP_CMD_NOT_SUPPORTED));
    return;
  }
  const cmd = data.buf.readUInt8(1);
  const atyp = data.buf.readUInt8(3);

  let host: string;
  let addrEnd: number; // index of the first byte AFTER the address (i.e. start of PORT)
  if (atyp === ATYP_IPV4) {
    if (data.buf.length < 8) return; // 4 header + 4 addr (port checked below)
    host = `${data.buf[4]}.${data.buf[5]}.${data.buf[6]}.${data.buf[7]}`;
    addrEnd = 8;
  } else if (atyp === ATYP_DOMAIN) {
    if (data.buf.length < 5) return;
    const len = data.buf.readUInt8(4);
    if (data.buf.length < 5 + len) return;
    host = data.buf.subarray(5, 5 + len).toString('latin1');
    addrEnd = 5 + len;
  } else if (atyp === ATYP_IPV6) {
    if (data.buf.length < 20) return; // 4 header + 16 addr
    const seg: string[] = [];
    for (let i = 0; i < 8; i++) seg.push(data.buf.readUInt16BE(4 + i * 2).toString(16));
    host = seg.join(':');
    addrEnd = 20;
  } else {
    endWith(client, data, socks5Reply(REP_CMD_NOT_SUPPORTED));
    return;
  }
  if (data.buf.length < addrEnd + 2) return; // wait for the 2 PORT bytes
  const port = data.buf.readUInt16BE(addrEnd);

  // Only CONNECT (0x01). BIND / UDP ASSOCIATE are refused — the sandbox never needs them.
  if (cmd !== 0x01) {
    deps.log?.(`socks5: unsupported command ${cmd}`);
    endWith(client, data, socks5Reply(REP_CMD_NOT_SUPPORTED));
    return;
  }

  if (!isValidHost(host)) {
    deps.log?.('socks5: malformed host rejected');
    endWith(client, data, socks5Reply(REP_NOT_ALLOWED));
    return;
  }

  // SAME gate as the HTTP path: allowlist first, then post-DNS SSRF re-check. A denied or
  // loopback/private host is refused with REP 0x02 before any upstream byte flows.
  if (!deps.isAllowed(host)) {
    deps.log?.(`egress denied (socks5): ${host}`);
    endWith(client, data, socks5Reply(REP_NOT_ALLOWED));
    return;
  }
  try {
    await deps.assertDialable(host);
  } catch {
    endWith(client, data, socks5Reply(REP_NOT_ALLOWED));
    return;
  }

  if (isClosed(data)) return; // client bailed while we awaited DNS

  let upstream: import('bun').Socket<{ client: ClientSocket; data: Socks5Data }>;
  try {
    upstream = await Bun.connect<{ client: ClientSocket; data: Socks5Data }>({
      hostname: host,
      port,
      socket: {
        data(_up, chunk) {
          client.write(chunk);
        },
        close() {
          client.end();
        },
        error() {
          client.end();
        }
      }
    });
  } catch {
    endWith(client, data, socks5Reply(REP_REFUSED));
    return;
  }
  upstream.data = { client, data };

  if (isClosed(data)) {
    upstream.end();
    return;
  }
  data.upstream = upstream;
  data.phase = 'piping';
  client.write(socks5Reply(REP_SUCCEEDED));

  // Any request bytes that trailed the CONNECT, plus anything buffered while connecting, go upstream.
  const trailing = data.buf.subarray(addrEnd + 2);
  if (trailing.length > 0) upstream.write(trailing);
  data.buf = Buffer.alloc(0);
  for (const buf of data.pending) upstream.write(buf);
  data.pending = [];
}
