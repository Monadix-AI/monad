// Mo desktop sprite drop endpoint: a dropped file/folder seeds a new session.
// Pure helpers are unit-tested; the HTTP route is exercised over both transports.

import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Elysia } from 'elysia';

import { buildSeedMessage, createMoModule, resolveDropPaths } from '@/handlers/mo/handlers.ts';
import { MoService } from '@/services/mo.ts';
import { createMoController } from '@/transports/http/mo/controller.ts';
import { createHttpTransport } from '@/transports/http.ts';
import { buildHandlers, mockModel, serveTransport, TRANSPORTS } from '../helpers.ts';

// Mo's routes are mounted on the app instance (not in createHttpTransport's type — see serve.ts).
// Tests bypass serve.ts, so mount them here the same way.
function moApp() {
  const handlers = buildHandlers(mockModel(['ok']));
  const app = createHttpTransport(handlers);
  (app as unknown as Elysia).use(
    createMoController(createMoModule(handlers.session, new MoService(undefined, '', 0, 'https')))
  );
  return app;
}

test('buildSeedMessage: user prompt leads, paths follow as a quoted list', () => {
  const msg = buildSeedMessage('summarize these', ['/tmp/a.txt', '/tmp/b.txt']);
  expect(msg.startsWith('summarize these')).toBe(true);
});

test('buildSeedMessage: blank prompt falls back to a default', () => {
  const msg = buildSeedMessage('   ', ['/tmp/a.txt']);
  expect(msg.startsWith('Take a look')).toBe(true);
});

test('buildSeedMessage: a path with quotes/backticks is JSON-escaped (no block breakout)', () => {
  const evil = '/tmp/`rm -rf`/"name".txt';
  const msg = buildSeedMessage(undefined, [evil]);
  expect(msg).toContain(JSON.stringify(evil));
  // The raw, unescaped string must not appear on its own line.
  expect(msg).not.toContain(`- ${evil}`);
});

test('resolveDropPaths: absolutizes, dedupes, drops non-existent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mo-drop-'));
  try {
    const file = join(dir, 'real.txt');
    writeFileSync(file, 'hi');
    const resolved = resolveDropPaths([file, file, join(dir, 'ghost.txt')]);
    expect(resolved).toEqual([file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /v1/mo/drop with a non-existent path: 400', async () => {
  const app = moApp();
  const res = await app.handle(
    new Request('http://localhost/v1/mo/drop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: [join(tmpdir(), 'definitely-missing-xyz')] })
    })
  );
  expect(res.status).toBe(400);
});

for (const kind of TRANSPORTS) {
  test(`POST /v1/mo/drop seeds a session over ${kind}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mo-drop-'));
    const file = join(dir, 'note.txt');
    writeFileSync(file, 'hello');
    const tr = serveTransport(kind, moApp());
    try {
      const res = await tr.fetch('/v1/mo/drop', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paths: [file], prompt: 'what is this?' })
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessionId: string };
      expect(body.sessionId).toMatch(/^ses_/);

      // The seeded session carries Mo's origin (client 'mo', http-writable web surface).
      const got = await tr.fetch(`/v1/sessions/${body.sessionId}`);
      expect(got.status).toBe(200);
      const { session } = (await got.json()) as {
        session: { origin?: { client: string; surface: string; transport: string } };
      };
      expect(session.origin?.client).toBe('mo');
      expect(session.origin?.transport).toBe('http');
    } finally {
      await tr.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
