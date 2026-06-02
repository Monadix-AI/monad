import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverChannelAdapters } from '#/channels/discover.ts';
import { AtomPackRegistry } from '#/handlers/atom-pack/index.ts';
import { createHttpTransport } from '#/transports/http.ts';
import { buildHandlers, makeTestPaths, mockModel, serveTransport, stubModelDeps, TRANSPORTS } from '../helpers.ts';

for (const transport of TRANSPORTS) {
  test(`workplace experience API dispatches over ${transport}`, async () => {
    const handlers = buildHandlers(mockModel(), undefined, {
      getWorkplaceExperienceApiRoute: (experienceId, method, path) => {
        if (experienceId !== 'canvas' || method !== 'POST' || path !== '/search') return undefined;
        return {
          atomPackId: 'pack-a',
          experienceId,
          method,
          path,
          permissions: ['experience.state'],
          handler: async (request, context) => {
            const body = (await request.json()) as { query?: string };
            return Response.json({
              result: `found:${body.query}`,
              pack: context.atomPackId
            });
          }
        };
      }
    });
    const live = serveTransport(transport, createHttpTransport(handlers));

    try {
      const res = await live.fetch('/v1/atoms/workplace-experiences/canvas/api/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'alpha' })
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ result: 'found:alpha', pack: 'pack-a' });
    } finally {
      await live.stop();
    }
  });

  test(`workplace experience API returns 404 for unregistered routes over ${transport}`, async () => {
    const handlers = buildHandlers(mockModel(), undefined, {
      getWorkplaceExperienceApiHandler: () => undefined
    });
    const live = serveTransport(transport, createHttpTransport(handlers));

    try {
      const res = await live.fetch('/v1/atoms/workplace-experiences/canvas/api/missing', { method: 'GET' });

      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      await live.stop();
    }
  });

  test(`mounted mock workplace experience exposes UI asset and API over ${transport}`, async () => {
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
        atoms: ['workplace-experience'],
        entry: 'dist/atom-pack.js'
      })
    );
    // A workplace experience is only served for a pack the operator installed and consented to for
    // this kind; a bare drop-in dir is refused (covered below).
    await writeFile(
      join(packDir, '.install.json'),
      JSON.stringify({
        source: 'local:/tmp/mock-experience',
        sourceId: 'local:/tmp/mock-experience',
        sourceKind: 'local',
        grantedAtoms: ['workplace-experience']
      })
    );
    await writeFile(
      join(packDir, 'dist', 'mock-canvas.js'),
      "customElements.define('mock-canvas', class extends HTMLElement { connectedCallback() { this.textContent = 'mounted'; } });\n"
    );
    await writeFile(
      join(packDir, 'dist', 'atom-pack.js'),
      `export default {
  manifest: { name: 'mock-experience', version: '1.0.0', sdkVersion: '0', atoms: ['workplace-experience'] },
  register(ctx) {
    ctx.registerWorkplaceExperience({
      id: 'mock-canvas',
      title: 'Mock Canvas',
      api: { routes: [{ method: 'POST', path: '/search' }] },
      entry: { type: 'web-component', module: './dist/mock-canvas.js', tagName: 'mock-canvas' }
    });
    ctx.registerWorkplaceExperienceApi({
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
      onWorkplaceExperience: (experience, atomPackId) => registry.registerWorkplaceExperience(experience, atomPackId),
      onWorkplaceExperienceApi: (api, atomPackId, permissions) =>
        registry.registerWorkplaceExperienceApi(api, atomPackId, permissions)
    });
    const handlers = buildHandlers(
      mockModel(),
      { ...stubModelDeps(), paths },
      {
        getWorkplaceExperienceApiHandler: (experienceId, method, path) =>
          registry.getWorkplaceExperienceApiHandler(experienceId, method, path),
        getWorkplaceExperiences: () => [...registry.workplaceExperiences.values()]
      }
    );
    const live = serveTransport(transport, createHttpTransport(handlers));

    try {
      expect(discovered.errors).toEqual([]);
      const listRes = await live.fetch('/v1/atoms/workplace-experiences');
      expect(listRes.status).toBe(200);
      expect(await listRes.json()).toEqual({
        experiences: [
          {
            id: 'mock-canvas',
            title: 'Mock Canvas',
            permissions: [],
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

      const apiRes = await live.fetch('/v1/atoms/workplace-experiences/mock-canvas/api/search', {
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

  test(`a drop-in pack serves no workplace experience over ${transport}`, async () => {
    const base = await mkdtemp(join(tmpdir(), 'monad-dropin-experience-'));
    const paths = makeTestPaths(base);
    const packDir = join(paths.packs, 'dropin-experience');
    await mkdir(join(packDir, 'dist'), { recursive: true });
    await writeFile(
      join(packDir, 'atom-pack.json'),
      JSON.stringify({
        name: 'dropin-experience',
        version: '1.0.0',
        sdkVersion: '0',
        atoms: ['workplace-experience'],
        entry: 'dist/atom-pack.js'
      })
    );
    await writeFile(
      join(packDir, 'dist', 'dropin-canvas.js'),
      "customElements.define('dropin-canvas', class extends HTMLElement {});\n"
    );
    await writeFile(
      join(packDir, 'dist', 'atom-pack.js'),
      `export default {
  manifest: { name: 'dropin-experience', version: '1.0.0', sdkVersion: '0', atoms: ['workplace-experience'] },
  register(ctx) {
    ctx.registerWorkplaceExperience({
      id: 'dropin-canvas',
      title: 'Drop-in Canvas',
      api: { routes: [{ method: 'POST', path: '/search' }] },
      entry: { type: 'web-component', module: './dist/dropin-canvas.js', tagName: 'dropin-canvas' }
    });
    ctx.registerWorkplaceExperienceApi({
      experienceId: 'dropin-canvas',
      routes: [{ method: 'POST', path: '/search', handle: async () => Response.json({ mounted: true }) }]
    });
  }
};\n`
    );

    const registry = new AtomPackRegistry();
    const warnings: string[] = [];
    const discovered = await discoverChannelAdapters(paths.packs, {
      log: (_level, msg) => warnings.push(msg),
      onWorkplaceExperience: (experience, atomPackId) => registry.registerWorkplaceExperience(experience, atomPackId),
      onWorkplaceExperienceApi: (api, atomPackId, permissions) =>
        registry.registerWorkplaceExperienceApi(api, atomPackId, permissions)
    });
    const handlers = buildHandlers(
      mockModel(),
      { ...stubModelDeps(), paths },
      {
        getWorkplaceExperienceApiHandler: (experienceId, method, path) =>
          registry.getWorkplaceExperienceApiHandler(experienceId, method, path),
        getWorkplaceExperiences: () => [...registry.workplaceExperiences.values()]
      }
    );
    const live = serveTransport(transport, createHttpTransport(handlers));

    try {
      expect(discovered.errors).toEqual([]);
      const listRes = await live.fetch('/v1/atoms/workplace-experiences');
      expect(listRes.status).toBe(200);
      expect(await listRes.json()).toEqual({ experiences: [] });

      const apiRes = await live.fetch('/v1/atoms/workplace-experiences/dropin-canvas/api/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'beta' })
      });
      expect(apiRes.status).toBe(404);
      expect(warnings).toEqual([
        'workplace experience "dropin-canvas" from "dropin-experience" refused: no install record — drop-in packs are not accepted for this kind',
        'workplace experience API routes for "dropin-canvas" from "dropin-experience" refused: no install record — drop-in packs are not accepted for this kind'
      ]);
    } finally {
      await live.stop();
      await rm(base, { recursive: true, force: true });
    }
  });
}
