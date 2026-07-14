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

import { materializeCredential } from '../../src/credential-materializer.ts';
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
        const status = Number((text.split('\r\n')[0] ?? '').split(' ')[1] ?? 0);
        const body = text.split('\r\n\r\n').slice(1).join('\r\n\r\n');
        resolve({ status, body });
      };
      tls.on('data', (d: Buffer) => buf.push(d));
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

  beforeAll(async () => {
    const pair = selfSigned127();
    upstreamCertPem = pair.cert;
    upstream = createHttpsServer({ cert: pair.cert, key: pair.key }, (req, res) => {
      serverSawRequest = true;
      serverSawAuth = String(req.headers.authorization ?? '');
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        serverSawBody = Buffer.concat(chunks).toString('utf8');
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

  function startProxy(filterRequest?: FilterRequest, registry?: SentinelRegistry) {
    return startEgressProxy({
      policy: { allowedDomains: ['*'] },
      isAllowed: () => true,
      assertDialable: async () => {},
      mitm: ca,
      // Trust the self-signed upstream on the proxy→server leg (test seam; verification stays ON).
      upstreamCA: upstreamCertPem,
      filterRequest,
      rewriteRequest: registry ? (host, block) => registry.substitute(host, block) : undefined,
      rewriteBody: registry ? (host, body) => registry.substitute(host, body) : undefined
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

  test('structured fake is restored byte-for-byte only on the authenticated matching TLS destination', async () => {
    const registry = new SentinelRegistry();
    const materialized = materializeCredential('token=structured-secret;scope=read', ['127.0.0.1'], {
      extract: 'token=([^;]+)'
    });
    if (!materialized.ok) throw new Error(materialized.error);
    registry.registerMaterialized('TOKEN', materialized.value.childValue, materialized.value.substitutions);
    serverSawAuth = '';
    const proxy = startProxy(undefined, registry);
    try {
      const req =
        'GET /echo HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
        `Authorization: Custom ${materialized.value.childValue}\r\nConnection: close\r\n\r\n`;
      const res = await driveClient(proxy.port, ca.caCertPath, upstreamPort, req);
      expect(res.status).toBe(200);
      expect(serverSawAuth).toBe('Custom token=structured-secret;scope=read');
      expect(serverSawAuth).not.toContain('fake_value_');
    } finally {
      proxy.stop();
    }
  });
});
