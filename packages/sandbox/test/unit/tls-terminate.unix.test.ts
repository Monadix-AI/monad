// Integration: drive a real client through the egress proxy's TLS-terminating path.
//
// The proxy's SSRF guard denies loopback, so isAllowed + assertDialable are overridden to point the
// test at a local self-signed HTTPS server on 127.0.0.1. A client opens a plain CONNECT to the
// proxy, TLS-handshakes over the tunnel trusting the MITM CA, and sends an HTTP/1.1 request. We
// assert the upstream server actually received it (proves termination end to end), the client got
// the echoed body, and a filterRequest returning {allow:false} blocks the request with 403.
//
// The proxy dials target.hostname:target.port (here 127.0.0.1:<upstreamPort>) and keeps REAL cert
// validation on that leg, so the upstream cert carries an IP SAN 127.0.0.1 and is threaded to the
// proxy as `upstreamCA`. Since EgressProxyOptions has no per-target upstreamCA hook, we pass it via
// a filterRequest that also stamps the target — see note in the proxy call.

import type { FilterRequest } from '../../src/mitm/terminate.ts';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer as createHttpsServer, type Server } from 'node:https';
import { connect as tcpConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import forge from 'node-forge';

import { ProtectedResponseBudget } from '../../src/credential-redaction-stream.ts';
import { SentinelRegistry } from '../../src/credential-sentinel.ts';
import { startEgressProxy } from '../../src/egress-proxy.ts';
import { createMitmCA, disposeMitmCA, type MitmCA } from '../../src/mitm/ca.ts';

function selfSigned127(): { cert: string; key: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 86400000);
  const attrs = [{ name: 'commonName', value: '127.0.0.1' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey) };
}

interface ClientResult {
  status: number;
  headers: string;
  body: string;
}

function driveClient(
  proxyPort: number,
  caCertPath: string,
  upstreamPort: number,
  request = 'GET /echo HTTP/1.1\r\nHost: 127.0.0.1\r\nx-probe: probe\r\nConnection: close\r\n\r\n'
): Promise<ClientResult> {
  const caCertPem = readFileSync(caCertPath, 'utf8');
  return new Promise((resolve, reject) => {
    const raw = tcpConnect({ host: '127.0.0.1', port: proxyPort });
    raw.on('error', reject);
    raw.once('connect', () => {
      raw.write(`CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\n\r\n`);
    });
    let established = false;
    const onData = (chunk: Buffer): void => {
      if (established) return;
      const s = chunk.toString('latin1');
      if (!s.startsWith('HTTP/1.1 200')) {
        raw.removeListener('data', onData);
        reject(new Error(`CONNECT failed: ${s.split('\r\n')[0]}`));
        return;
      }
      established = true;
      raw.removeListener('data', onData);
      // No SNI (Node forbids an IP servername). The MITM CA (`ca`) is the trust anchor being
      // verified — the security-relevant assertion; leaf-SAN string matching is not what's under
      // test here, so skip hostname identity.
      const tls = tlsConnect({ socket: raw, ca: caCertPem, checkServerIdentity: () => undefined });
      tls.on('error', reject);
      tls.once('secureConnect', () => {
        tls.write(request);
      });
      const buf: Buffer[] = [];
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        const text = Buffer.concat(buf).toString('utf8');
        const [headers = '', ...bodyParts] = text.split('\r\n\r\n');
        const status = Number((headers.split('\r\n')[0] ?? '').split(' ')[1] ?? 0);
        resolve({ status, headers, body: bodyParts.join('\r\n\r\n') });
      };
      tls.on('data', (d: Buffer) => {
        buf.push(d);
        const response = Buffer.concat(buf);
        const headerEnd = response.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const headers = response.subarray(0, headerEnd).toString('latin1');
        const lengthMatch = /\r\ncontent-length:\s*(\d+)\r\n/i.exec(`\r\n${headers}\r\n`);
        if (lengthMatch && response.length - headerEnd - 4 >= Number(lengthMatch[1])) finish();
        else if (
          /\r\ntransfer-encoding:\s*chunked\r\n/i.test(`\r\n${headers}\r\n`) &&
          response.includes('\r\n0\r\n\r\n')
        )
          finish();
      });
      tls.once('end', finish);
      tls.once('close', finish);
    };
    raw.on('data', onData);
  });
}

describe('egress proxy TLS termination', () => {
  let upstream: Server;
  let upstreamPort: number;
  let upstreamCertPem: string;
  let ca: MitmCA;
  let serverSawRequest = false;
  let serverSawAuth = '';
  let serverSawBody = '';
  let serverSawUrl = '';
  let serverSawAcceptEncoding = '';
  const responseCanary = 'reflected-response-secret';
  const crossHostCanary = 'cross-host-response-secret';
  const headerNameCanary = 'header-name-secret-canary';
  let heldResponseStarted: (() => void) | undefined;
  let releaseHeldResponse: (() => void) | undefined;

  beforeAll(async () => {
    const pair = selfSigned127();
    upstreamCertPem = pair.cert;
    upstream = createHttpsServer({ cert: pair.cert, key: pair.key }, (req, res) => {
      serverSawRequest = true;
      serverSawAuth = String(req.headers.authorization ?? '');
      serverSawUrl = req.url ?? '';
      serverSawAcceptEncoding = String(req.headers['accept-encoding'] ?? '');
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        serverSawBody = Buffer.concat(chunks).toString('utf8');
        if (req.url === '/reflect-response') {
          res.writeHead(200, { 'content-type': 'text/plain', 'x-reflected-credential': responseCanary });
          res.end(`before:${responseCanary}:after`);
          return;
        }
        if (req.url === '/reflect-split') {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.write(responseCanary.slice(0, 7));
          res.end(responseCanary.slice(7));
          return;
        }
        if (req.url === '/compressed-response') {
          res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
          res.end(responseCanary);
          return;
        }
        if (req.url === '/binary-response') {
          res.writeHead(200, { 'content-type': 'application/octet-stream' });
          res.end(Buffer.concat([Buffer.from([0xff, 0x00]), Buffer.from(responseCanary)]));
          return;
        }
        if (req.url === '/invalid-text-response') {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end(Buffer.from([0xc0, 0xaf, 0xff]));
          return;
        }
        if (req.url === '/oversized-response') {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end(Buffer.alloc(1024 * 1024 + 1, 0x61));
          return;
        }
        if (req.url === '/cross-host-response') {
          res.writeHead(200, { 'content-type': 'text/plain', 'x-cross-host': crossHostCanary });
          res.write(crossHostCanary.slice(0, 8));
          res.end(crossHostCanary.slice(8));
          return;
        }
        if (req.url === '/unsafe-header-name') {
          res.writeHead(200, { 'content-type': 'text/plain', [headerNameCanary]: 'reflected' });
          res.end('safe');
          return;
        }
        if (req.url === '/held-response') {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.flushHeaders();
          heldResponseStarted?.();
          void new Promise<void>((resolve) => {
            releaseHeldResponse = resolve;
          }).then(() => res.end(responseCanary));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`echo:${req.headers['x-probe'] ?? ''}:${req.url}`);
      });
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    upstreamPort = (upstream.address() as { port: number }).port;
    ca = createMitmCA();
  });

  afterAll(async () => {
    upstream.close();
    await disposeMitmCA(ca);
  });

  function startProxy(
    filterRequest?: FilterRequest,
    registry?: SentinelRegistry,
    onProtectedResponseFailure?: (code: string) => void,
    protectedResponseBudget?: ProtectedResponseBudget
  ) {
    return startEgressProxy({
      policy: { allowedDomains: ['*'] },
      isAllowed: () => true,
      assertDialable: async () => {},
      mitm: ca,
      // Trust the self-signed upstream on the proxy→server leg (test seam; verification stays ON).
      upstreamCA: upstreamCertPem,
      filterRequest,
      rewriteRequest: registry ? (host, block) => registry.substitute(host, block) : undefined,
      rewriteBody: registry ? (host, body) => registry.substitute(host, body) : undefined,
      responseRedactions: registry ? () => registry.redactionsForResponse() : undefined,
      onProtectedResponseFailure,
      protectedResponseBudget
    });
  }

  test('terminates TLS: upstream receives the request and client gets the echoed response', async () => {
    serverSawRequest = false;
    const proxy = startProxy();
    try {
      const res = await driveClient(proxy.port, ca.caCertPath, upstreamPort);
      expect(serverSawRequest).toBe(true);
      expect(res.status).toBe(200);
      expect(res.body).toContain('echo:probe:/echo');
    } finally {
      proxy.stop();
    }
  });

  test('filterRequest returning {allow:false} blocks the request with 403', async () => {
    serverSawRequest = false;
    const proxy = startProxy(() => ({ allow: false }));
    try {
      const res = await driveClient(proxy.port, ca.caCertPath, upstreamPort);
      expect(res.status).toBe(403);
      expect(serverSawRequest).toBe(false);
    } finally {
      proxy.stop();
    }
  });

  test('sentinel is swapped to the real value on the outbound leg when the host matches injectHosts', async () => {
    // Proxy dials 127.0.0.1 (the upstream), so the substitution host key is 127.0.0.1.
    const registry = new SentinelRegistry();
    const sentinel = registry.register('TOKEN', 'supersecret', ['127.0.0.1']);
    serverSawAuth = '';
    const proxy = startProxy(undefined, registry);
    try {
      const req = `GET /echo HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${sentinel}\r\nConnection: close\r\n\r\n`;
      const res = await driveClient(proxy.port, ca.caCertPath, upstreamPort, req);
      expect(res.status).toBe(200);
      // Upstream (allowed host) received the REAL value; the sentinel was swapped on the proxy→server leg.
      expect(serverSawAuth).toBe('Bearer supersecret');
    } finally {
      proxy.stop();
    }
  });

  test('sentinel is LEFT intact when the host is not in injectHosts (real value never leaks)', async () => {
    // injectHosts targets a different host, so on 127.0.0.1 the sentinel is not swapped.
    const registry = new SentinelRegistry();
    const sentinel = registry.register('TOKEN', 'supersecret', ['api.example.com']);
    serverSawAuth = '';
    const proxy = startProxy(undefined, registry);
    try {
      const req = `GET /echo HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${sentinel}\r\nConnection: close\r\n\r\n`;
      const res = await driveClient(proxy.port, ca.caCertPath, upstreamPort, req);
      expect(res.status).toBe(200);
      // Upstream (non-injectHost) received the SENTINEL, never the real value.
      expect(serverSawAuth).toBe(`Bearer ${sentinel}`);
      expect(serverSawAuth).not.toContain('supersecret');
    } finally {
      proxy.stop();
    }
  });

  test('sentinel in a POST body is swapped to the real value on the outbound leg', async () => {
    const registry = new SentinelRegistry();
    const sentinel = registry.register('TOKEN', 'supersecret', ['127.0.0.1']);
    serverSawBody = '';
    const proxy = startProxy(undefined, registry);
    try {
      const body = JSON.stringify({ token: sentinel });
      const req =
        'POST /echo HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n' +
        `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
      const res = await driveClient(proxy.port, ca.caCertPath, upstreamPort, req);
      expect(res.status).toBe(200);
      // Upstream received the REAL value in the body; the fake never reached it, and Content-Length
      // was recomputed so the request stayed well-formed.
      expect(serverSawBody).toBe(JSON.stringify({ token: 'supersecret' }));
      expect(serverSawBody).not.toContain(sentinel);
    } finally {
      proxy.stop();
    }
  });

  test('a non-textual request body is forwarded without decoding or credential substitution', async () => {
    const registry = new SentinelRegistry();
    const sentinel = registry.register('TOKEN', 'binary-body-secret', ['127.0.0.1']);
    serverSawBody = '';
    const proxy = startProxy(undefined, registry);
    try {
      const body = Buffer.from(sentinel);
      const req =
        'POST /echo HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/octet-stream\r\n' +
        `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n${body.toString('latin1')}`;
      const res = await driveClient(proxy.port, ca.caCertPath, upstreamPort, req);
      expect(res.status).toBe(200);
      expect(serverSawBody).toBe(sentinel);
    } finally {
      proxy.stop();
    }
  });

  test('request URL substitution and Accept-Encoding normalization use the authenticated CONNECT destination', async () => {
    const registry = new SentinelRegistry();
    const sentinel = registry.register('TOKEN', 'url-secret', ['127.0.0.1']);
    serverSawUrl = '';
    serverSawAcceptEncoding = '';
    const proxy = startProxy(undefined, registry);
    try {
      const req =
        `GET /echo?token=${sentinel} HTTP/1.1\r\nHost: spoofed.example\r\n` +
        'Accept-Encoding: gzip, br\r\nConnection: close\r\n\r\n';
      const res = await driveClient(proxy.port, ca.caCertPath, upstreamPort, req);
      expect(res.status).toBe(200);
      expect({ url: serverSawUrl, acceptEncoding: serverSawAcceptEncoding }).toEqual({
        url: '/echo?token=url-secret',
        acceptEncoding: 'identity'
      });
    } finally {
      proxy.stop();
    }
  });

  test('a spoofed Host header cannot authorize a credential for another destination', async () => {
    const registry = new SentinelRegistry();
    const sentinel = registry.register('TOKEN', 'host-scoped-secret', ['spoofed.example']);
    serverSawAuth = '';
    const proxy = startProxy(undefined, registry);
    try {
      const req =
        `GET /echo HTTP/1.1\r\nHost: spoofed.example\r\nAuthorization: Bearer ${sentinel}\r\n` +
        'Connection: close\r\n\r\n';
      const res = await driveClient(proxy.port, ca.caCertPath, upstreamPort, req);
      expect(res.status).toBe(200);
      expect(serverSawAuth).toBe(`Bearer ${sentinel}`);
    } finally {
      proxy.stop();
    }
  });

  test('reflected credentials in response headers and a one-chunk textual body return only the sentinel', async () => {
    const registry = new SentinelRegistry();
    const sentinel = registry.register('TOKEN', responseCanary, ['127.0.0.1']);
    const proxy = startProxy(undefined, registry);
    try {
      const req = 'GET /reflect-response HTTP/1.1\r\nHost: spoofed.example\r\nConnection: close\r\n\r\n';
      const res = await driveClient(proxy.port, ca.caCertPath, upstreamPort, req);
      expect(res.status).toBe(200);
      expect(res.headers.toLowerCase()).toContain(`x-reflected-credential: ${sentinel}`);
      expect(`${res.headers}\r\n\r\n${res.body}`).not.toContain(responseCanary);
      expect(res.body).toContain(`before:${sentinel}:after`);
    } finally {
      proxy.stop();
    }
  });

  test('a reflected credential split across upstream response chunks returns only the sentinel', async () => {
    const registry = new SentinelRegistry();
    const sentinel = registry.register('TOKEN', responseCanary, ['127.0.0.1']);
    const proxy = startProxy(undefined, registry);
    try {
      const req = 'GET /reflect-split HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n';
      const res = await driveClient(proxy.port, ca.caCertPath, upstreamPort, req);
      expect(res.status).toBe(200);
      expect(res.body).toContain(sentinel);
      expect(res.body).not.toContain(responseCanary);
    } finally {
      proxy.stop();
    }
  });

  test('a host response redacts another granted host credential in headers and split body chunks', async () => {
    const registry = new SentinelRegistry();
    registry.register('A_TOKEN', 'request-host-secret', ['127.0.0.1']);
    const crossHostSentinel = registry.register('B_TOKEN', crossHostCanary, ['b.example']);
    const proxy = startProxy(undefined, registry);
    try {
      const req = 'GET /cross-host-response HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n';
      const res = await driveClient(proxy.port, ca.caCertPath, upstreamPort, req);
      expect({
        status: res.status,
        header: res.headers.toLowerCase().includes(`x-cross-host: ${crossHostSentinel}`),
        body: res.body.includes(crossHostSentinel),
        leaked: `${res.headers}${res.body}`.includes(crossHostCanary)
      }).toEqual({ status: 200, header: true, body: true, leaked: false });
    } finally {
      proxy.stop();
    }
  });

  test.each([headerNameCanary, headerNameCanary.toUpperCase()])(
    'fails before delivering a response header name containing secret %s',
    async (secret) => {
      const registry = new SentinelRegistry();
      registry.register('TOKEN', secret, ['127.0.0.1']);
      const failures: string[] = [];
      const proxy = startProxy(undefined, registry, (code) => failures.push(code));
      try {
        const req = 'GET /unsafe-header-name HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n';
        const res = await driveClient(proxy.port, ca.caCertPath, upstreamPort, req);
        expect({ status: res.status, failures, leaked: res.headers.toLowerCase().includes(headerNameCanary) }).toEqual({
          status: 502,
          failures: ['protected_response_header_name_unsafe'],
          leaked: false
        });
      } finally {
        proxy.stop();
      }
    }
  );

  test('execution budget fails a concurrent protected response before delivery and releases afterward', async () => {
    const registry = new SentinelRegistry();
    registry.register('TOKEN', responseCanary, ['127.0.0.1']);
    const failures: string[] = [];
    const budget = new ProtectedResponseBudget();
    const proxy = startProxy(undefined, registry, (code) => failures.push(code), budget);
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    heldResponseStarted = startedResolve;
    try {
      const first = driveClient(
        proxy.port,
        ca.caCertPath,
        upstreamPort,
        'GET /held-response HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'
      );
      await started;
      await Bun.sleep(20);
      const concurrent = await driveClient(
        proxy.port,
        ca.caCertPath,
        upstreamPort,
        'GET /reflect-response HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'
      );
      releaseHeldResponse?.();
      const completed = await first;
      const afterRelease = await driveClient(
        proxy.port,
        ca.caCertPath,
        upstreamPort,
        'GET /reflect-response HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'
      );
      expect({
        concurrent: concurrent.status,
        completed: completed.status,
        afterRelease: afterRelease.status,
        failures
      }).toEqual({
        concurrent: 502,
        completed: 200,
        afterRelease: 200,
        failures: ['protected_response_budget_exceeded']
      });
    } finally {
      releaseHeldResponse?.();
      heldResponseStarted = undefined;
      releaseHeldResponse = undefined;
      proxy.stop();
    }
  });

  test.each([
    ['/compressed-response', 'compressed', 'protected_response_compressed'],
    ['/binary-response', 'binary', 'protected_response_unsupported_content_type'],
    ['/invalid-text-response', 'invalid text', 'protected_response_invalid_text'],
    ['/oversized-response', 'oversized', 'protected_response_too_large']
  ])('fails a protected %s response instead of forwarding unsafe bytes', async (path, _label, expectedCode) => {
    const registry = new SentinelRegistry();
    registry.register('TOKEN', responseCanary, ['127.0.0.1']);
    const failures: string[] = [];
    const proxy = startProxy(undefined, registry, (code) => failures.push(code));
    try {
      const req = `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`;
      const res = await driveClient(proxy.port, ca.caCertPath, upstreamPort, req);
      expect({ status: res.status, bodyContainsCanary: res.body.includes(responseCanary) }).toEqual({
        status: 502,
        bodyContainsCanary: false
      });
      expect(failures).toEqual([expectedCode]);
      expect(failures.join('')).not.toContain(responseCanary);
    } finally {
      proxy.stop();
    }
  });
});
