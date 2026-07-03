import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverChannelAdapters } from '@/channels/discover.ts';
import { AtomPackRegistry } from '@/handlers/atom-pack/index.ts';
import { createHttpTransport } from '@/transports/http.ts';
import { buildHandlers, makeTestPaths, mockModel, serveTransport, stubModelDeps, TRANSPORTS } from '../helpers.ts';

for (const transport of TRANSPORTS) {
  test(`workspace experience API dispatches over ${transport}`, async () => {
    const handlers = buildHandlers(mockModel(), undefined, {
      getWorkspaceExperienceApiHandler: (experienceId, method, path) => {
        if (experienceId !== 'canvas' || method !== 'POST' || path !== '/search') return undefined;
        return async (request) => {
          const body = (await request.json()) as { query?: string };
          return Response.json({ result: `found:${body.query}` });
        };
      }
    });
    const live = serveTransport(transport, createHttpTransport(handlers));

    try {
      const res = await live.fetch('/v1/atoms/workspace-experiences/canvas/api/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'alpha' })
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ result: 'found:alpha' });
    } finally {
      await live.stop();
    }
  });

  test(`workspace experience API returns 404 for unregistered routes over ${transport}`, async () => {
    const handlers = buildHandlers(mockModel(), undefined, {
      getWorkspaceExperienceApiHandler: () => undefined
    });
    const live = serveTransport(transport, createHttpTransport(handlers));

    try {
      const res = await live.fetch('/v1/atoms/workspace-experiences/canvas/api/missing', { method: 'GET' });

      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      await live.stop();
    }
  });

  test(`mounted mock workspace experience exposes UI asset and API over ${transport}`, async () => {
    const base = await mkdtemp(join(tmpdir(), 'monad-mounted-experience-'));
    const paths = makeTestPaths(base);
    const packDir = join(paths.packs, 'mock-experience');
    await mkdir(join(packDir, 'dist'), { recursive: true });
    await writeFile(
      join(packDir, 'atom-pack.json'),
      JSON.stringify({
        name: 'mock-experience',
        version: '1.0.0',
        sdkVersion: '0',
        atoms: ['workspace-experience'],
        entry: 'dist/atom-pack.js'
      })
    );
    await writeFile(
      join(packDir, 'dist', 'mock-canvas.js'),
      "customElements.define('mock-canvas', class extends HTMLElement { connectedCallback() { this.textContent = 'mounted'; } });\n"
    );
    await writeFile(
      join(packDir, 'dist', 'atom-pack.js'),
      `export default {
  manifest: { name: 'mock-experience', version: '1.0.0', sdkVersion: '0', atoms: ['workspace-experience'] },
  register(ctx) {
    ctx.registerWorkspaceExperience({
      id: 'mock-canvas',
      title: 'Mock Canvas',
      api: { routes: [{ method: 'POST', path: '/search' }] },
      entry: { type: 'web-component', module: './dist/mock-canvas.js', tagName: 'mock-canvas' }
    });
    ctx.registerWorkspaceExperienceApi({
      experienceId: 'mock-canvas',
      routes: [{
        method: 'POST',
        path: '/search',
        handle: async (request) => {
          const body = await request.json();
          return Response.json({ mounted: true, query: body.query });
        }
      }]
    });
  }
};\n`
    );

    const registry = new AtomPackRegistry();
    const discovered = await discoverChannelAdapters(paths.packs, {
      onWorkspaceExperience: (experience, atomPackId) => registry.registerWorkspaceExperience(experience, atomPackId),
      onWorkspaceExperienceApi: (api, atomPackId) => registry.registerWorkspaceExperienceApi(api, atomPackId)
    });
    const handlers = buildHandlers(
      mockModel(),
      { ...stubModelDeps(), paths },
      {
        getWorkspaceExperienceApiHandler: (experienceId, method, path) =>
          registry.getWorkspaceExperienceApiHandler(experienceId, method, path),
        getWorkspaceExperiences: () => [...registry.workspaceExperiences.values()]
      }
    );
    const live = serveTransport(transport, createHttpTransport(handlers));

    try {
      expect(discovered.errors).toEqual([]);
      const listRes = await live.fetch('/v1/atoms/workspace-experiences');
      expect(listRes.status).toBe(200);
      expect(await listRes.json()).toEqual({
        experiences: [
          {
            id: 'mock-canvas',
            title: 'Mock Canvas',
            api: { routes: [{ method: 'POST', path: '/search' }] },
            entry: {
              type: 'web-component',
              module: '/v1/atoms/mock-experience/assets/dist/mock-canvas.js',
              tagName: 'mock-canvas'
            }
          }
        ]
      });

      const assetRes = await live.fetch('/v1/atoms/mock-experience/assets/dist/mock-canvas.js');
      expect(assetRes.status).toBe(200);
      expect(await assetRes.text()).toContain("customElements.define('mock-canvas'");

      const apiRes = await live.fetch('/v1/atoms/workspace-experiences/mock-canvas/api/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'beta' })
      });
      expect(apiRes.status).toBe(200);
      expect(await apiRes.json()).toEqual({ mounted: true, query: 'beta' });
    } finally {
      await live.stop();
      await rm(base, { recursive: true, force: true });
    }
  });
}
