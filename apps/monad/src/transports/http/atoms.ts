import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';

import {
  atomPackUpdateCheckSchema,
  checkSkillUpdatesResponseSchema,
  createSkillRequestSchema,
  createSkillResponseSchema,
  getAtomPackResponseSchema,
  getInstalledMcpAtomResponseSchema,
  getInstalledSkillResponseSchema,
  getSkillContentResponseSchema,
  httpErrorSchema,
  installAtomPackRequestSchema,
  installAtomPackResponseSchema,
  installLocalSkillRequestSchema,
  installMcpAtomRequestSchema,
  installMcpAtomResponseSchema,
  installMcpBinaryRequestSchema,
  installSkillRequestSchema,
  installSkillResponseSchema,
  listAtomPacksResponseSchema,
  listInstalledMcpAtomsResponseSchema,
  listInstalledSkillsResponseSchema,
  listWorkplaceExperiencesResponseSchema,
  okResponseSchema,
  setAtomPinRequestSchema,
  skillContentQuerySchema,
  updateAtomPackRequestSchema,
  updateSkillContentRequestSchema,
  updateSkillRequestSchema,
  uploadSkillQuerySchema,
  validateSkillsRequestSchema,
  validateSkillsResponseSchema
} from '@monad/protocol';
import { Elysia } from 'elysia';
import { z } from 'zod';

import { HandlerError } from '#/handlers/handler-error.ts';
import { readRequestBytes } from '#/services/upload.ts';

// HTTP-only surface: contract declared inline; reusable wire schemas come from @monad/protocol.
const packParams = z.object({ name: z.string() });
const assetParams = z.object({ name: z.string(), '*': z.string() });
const workplaceExperienceApiParams = z.object({ experienceId: z.string(), '*': z.string() });
const SKILL_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

export function createAtomsController(handlers: ReturnType<typeof createDaemonHandlers>) {
  return new Elysia({ tags: ['http-only'] })
    .get('/atoms', async () => handlers.atoms.listAtomPacks(), {
      response: { 200: listAtomPacksResponseSchema },
      detail: {
        summary: 'List installed Atom Packs',
        description: 'Returns installed Atom Packs and their included Atom types.'
      }
    })
    .get('/atoms/workplace-experiences', async () => handlers.atoms.listWorkplaceExperiences(), {
      response: { 200: listWorkplaceExperiencesResponseSchema },
      detail: {
        summary: 'List workplace experiences',
        description: 'Returns workplace-experience Atoms registered by loaded Atom Packs.'
      }
    })
    .all(
      '/atoms/workplace-experiences/:experienceId/api/*',
      async ({ params, request }) => {
        const path = `/${params['*'] ?? ''}`;
        const handler = handlers.atoms.getWorkplaceExperienceApiHandler(params.experienceId, request.method, path);
        if (!handler) {
          throw new HandlerError(
            'not_found',
            `workplace experience API route not found: ${request.method} ${params.experienceId}${path}`
          );
        }
        return handler(request);
      },
      {
        params: workplaceExperienceApiParams,
        detail: {
          summary: 'Dispatch a workplace experience API request',
          description:
            'Fixed daemon endpoint that routes to the registered API handler for a workplace-experience Atom.'
        }
      }
    )
    .get(
      '/atoms/:name/assets/*',
      async ({ params }) => {
        const asset = await handlers.atoms.getAtomPackAsset({ name: params.name, path: params['*'] });
        const body = new Uint8Array(asset.bytes).buffer;
        return new Response(body, {
          headers: {
            ...(asset.contentType ? { 'content-type': asset.contentType } : {}),
            'cache-control': 'no-store'
          }
        });
      },
      {
        params: assetParams,
        detail: {
          summary: 'Serve an Atom Pack asset',
          description: 'Serves browser-loadable assets from an installed Atom Pack without path traversal.'
        }
      }
    )
    .post('/atoms/install', async ({ body }) => handlers.atoms.installAtomPack(body), {
      body: installAtomPackRequestSchema,
      response: { 200: installAtomPackResponseSchema },
      detail: {
        summary: 'Install an Atom Pack',
        description:
          'Install from a GitHub repository or local development directory. Default-deny: re-call with consent:true.'
      }
    })
    .get('/atoms/:name', async ({ params }) => handlers.atoms.getAtomPack({ name: params.name }), {
      params: packParams,
      response: { 200: getAtomPackResponseSchema, 404: httpErrorSchema },
      detail: { summary: 'Get an Atom Pack', description: 'Returns one installed Atom Pack by name.' }
    })
    .get('/atoms/:name/update', async ({ params }) => handlers.atoms.checkAtomPackUpdate({ name: params.name }), {
      params: packParams,
      response: { 200: atomPackUpdateCheckSchema, 400: httpErrorSchema, 404: httpErrorSchema },
      detail: {
        summary: 'Check an Atom Pack update',
        description: 'Compares the installed revision with its GitHub repository or local development directory.'
      }
    })
    .post(
      '/atoms/:name/update',
      async ({ params, body }) => handlers.atoms.updateAtomPack({ name: params.name, ...body }),
      {
        params: packParams,
        body: updateAtomPackRequestSchema,
        response: { 200: installAtomPackResponseSchema, 400: httpErrorSchema, 404: httpErrorSchema },
        detail: {
          summary: 'Confirm an Atom Pack update',
          description:
            'Reinstalls from the checked source after explicit confirmation while preserving Atom availability.'
        }
      }
    )
    .post(
      '/atoms/:name/enable',
      async ({ params }) => handlers.atoms.setAtomPackEnabled({ name: params.name, enabled: true }),
      {
        params: packParams,
        response: { 200: okResponseSchema, 404: httpErrorSchema },
        detail: {
          summary: "Enable an Atom Pack's Atoms",
          description: "Makes the installed Atom Pack's Atoms available."
        }
      }
    )
    .post(
      '/atoms/:name/disable',
      async ({ params }) => handlers.atoms.setAtomPackEnabled({ name: params.name, enabled: false }),
      {
        params: packParams,
        response: { 200: okResponseSchema, 404: httpErrorSchema },
        detail: {
          summary: "Disable an Atom Pack's Atoms",
          description: "Makes the installed Atom Pack's Atoms unavailable by skipping them during discovery."
        }
      }
    )
    .delete('/atoms/:name', async ({ params }) => handlers.atoms.removeAtomPack({ name: params.name }), {
      params: packParams,
      response: { 200: okResponseSchema, 404: httpErrorSchema },
      detail: { summary: 'Remove an Atom Pack', description: 'Deletes an installed Atom Pack directory.' }
    })
    .post('/atoms/pin', async ({ body }) => handlers.atoms.setAtomPin(body), {
      body: setAtomPinRequestSchema,
      response: { 200: okResponseSchema },
      detail: {
        summary: 'Pin a bare-name winner',
        description: 'Pin which pack wins a bare id (packId:null clears it → first-wins); re-resolves live.'
      }
    })
    .get('/atoms/skills', async () => handlers.atoms.listInstalledSkills(), {
      response: { 200: listInstalledSkillsResponseSchema },
      detail: { summary: 'List installed skills', description: 'Standalone skill atoms under atoms/skills/.' }
    })
    .post('/atoms/skills', async ({ body }) => handlers.atoms.createSkill(body), {
      body: createSkillRequestSchema,
      response: { 200: createSkillResponseSchema },
      detail: {
        summary: 'Create a skill',
        description: 'Scaffold a personal skill from raw SKILL.md content (validated + hot-reloaded).'
      }
    })
    .post(
      '/atoms/skills/upload',
      async ({ query, request }) =>
        handlers.atoms.uploadSkill({
          agentId: query.agentId,
          filename: query.filename,
          bytes: await readRequestBytes(request, SKILL_UPLOAD_MAX_BYTES),
          overwrite: query.overwrite === 'true'
        }),
      {
        query: uploadSkillQuerySchema,
        response: { 200: installSkillResponseSchema },
        detail: {
          summary: 'Upload a skill file',
          description:
            'Install a selected SKILL.md or zip archive payload from an application/octet-stream body (validated + hot-reloaded).'
        }
      }
    )
    .post('/atoms/skills/local', async ({ body }) => handlers.atoms.installLocalSkill(body), {
      body: installLocalSkillRequestSchema,
      response: { 200: installSkillResponseSchema },
      detail: {
        summary: 'Install skills from a local path',
        description: 'Daemon reads + installs every skill under a local filesystem path (hot-reloads).'
      }
    })
    .post('/atoms/skills/validate', async ({ body }) => handlers.atoms.validateSkills(body), {
      body: validateSkillsRequestSchema,
      response: { 200: validateSkillsResponseSchema },
      detail: {
        summary: 'Validate skills under a local path',
        description: 'Lints every SKILL.md under a local path (parse + dir-name match) without installing.'
      }
    })
    .post('/atoms/skills/install', async ({ body }) => handlers.atoms.installSkill(body), {
      body: installSkillRequestSchema,
      response: { 200: installSkillResponseSchema },
      detail: {
        summary: 'Install a skill from github',
        description:
          'Fetch github:owner/repo@<ref> (no git binary), version-lock + hot-reload. Default-deny: re-call with consent:true.'
      }
    })
    .get('/atoms/skills/updates', async () => handlers.atoms.checkSkillUpdates(), {
      response: { 200: checkSkillUpdatesResponseSchema },
      detail: {
        summary: 'Check skill updates',
        description: "Compares each github-installed skill's locked commit against its ref's current head."
      }
    })
    .get('/atoms/skills/:name', async ({ params }) => handlers.atoms.getInstalledSkill({ name: params.name }), {
      params: packParams,
      response: { 200: getInstalledSkillResponseSchema, 404: httpErrorSchema },
      detail: { summary: 'Get an installed skill', description: 'Returns one standalone skill atom by name.' }
    })
    .delete('/atoms/skills/:name', async ({ params }) => handlers.atoms.removeSkill({ name: params.name }), {
      params: packParams,
      response: { 200: okResponseSchema, 404: httpErrorSchema },
      detail: { summary: 'Remove a skill', description: 'Deletes an installed skill directory (hot-reloads).' }
    })
    .get(
      '/atoms/skills/:name/content',
      async ({ params, query }) =>
        handlers.atoms.getSkillContent({ name: params.name, file: query.file, id: query.id }),
      {
        params: packParams,
        query: skillContentQuerySchema,
        response: { 200: getSkillContentResponseSchema, 404: httpErrorSchema },
        detail: { summary: 'Read a skill file', description: 'Returns the installed SKILL.md content for editing.' }
      }
    )
    .put(
      '/atoms/skills/:name/content',
      async ({ params, query, body }) =>
        handlers.atoms.updateSkillContent({ name: params.name, id: query.id, content: body.content }),
      {
        params: packParams,
        query: skillContentQuerySchema,
        body: updateSkillContentRequestSchema,
        response: { 200: createSkillResponseSchema, 404: httpErrorSchema },
        detail: { summary: 'Edit a skill file', description: 'Replaces an installed SKILL.md after validation.' }
      }
    )
    .post(
      '/atoms/skills/:name/update',
      async ({ params, body }) => handlers.atoms.updateSkill({ name: params.name, consent: body.consent }),
      {
        params: packParams,
        body: updateSkillRequestSchema,
        response: { 200: installSkillResponseSchema, 404: httpErrorSchema },
        detail: { summary: 'Update a skill', description: "Re-install a github skill from its source's current head." }
      }
    )
    .get('/atoms/mcp', async () => handlers.atoms.listMcpAtoms(), {
      response: { 200: listInstalledMcpAtomsResponseSchema },
      detail: { summary: 'List installed MCP atoms', description: 'Registry-style MCP servers under atoms/mcp/.' }
    })
    .post('/atoms/mcp/install', async ({ body }) => handlers.atoms.installMcpAtom(body), {
      body: installMcpAtomRequestSchema,
      response: { 200: installMcpAtomResponseSchema },
      detail: {
        summary: 'Install an MCP server',
        description: 'Write a hot atoms/mcp/<name>.json (npx/uvx or http). Default-deny: re-call with consent:true.'
      }
    })
    .post('/atoms/mcp/install-binary', async ({ body }) => handlers.atoms.installMcpBinary(body), {
      body: installMcpBinaryRequestSchema,
      response: { 200: installMcpAtomResponseSchema },
      detail: {
        summary: 'Install a prebuilt MCP binary',
        description:
          'Download a GitHub release asset (platform/arch) + verify SHA-256 → hot atoms/mcp atom. Default-deny: re-call with consent:true.'
      }
    })
    .get('/atoms/mcp/:name', async ({ params }) => handlers.atoms.getMcpAtom({ name: params.name }), {
      params: packParams,
      response: { 200: getInstalledMcpAtomResponseSchema, 404: httpErrorSchema },
      detail: { summary: 'Get an installed MCP atom', description: 'Returns one registry-style MCP atom by name.' }
    })
    .post(
      '/atoms/mcp/:name/enable',
      async ({ params }) => handlers.atoms.setMcpAtomEnabled({ name: params.name, enabled: true }),
      {
        params: packParams,
        response: { 200: okResponseSchema, 404: httpErrorSchema },
        detail: { summary: 'Enable an MCP server', description: 'Connects the atoms/mcp atom (hot).' }
      }
    )
    .post(
      '/atoms/mcp/:name/disable',
      async ({ params }) => handlers.atoms.setMcpAtomEnabled({ name: params.name, enabled: false }),
      {
        params: packParams,
        response: { 200: okResponseSchema, 404: httpErrorSchema },
        detail: { summary: 'Disable an MCP server', description: 'Disconnects the atoms/mcp atom (hot).' }
      }
    )
    .delete('/atoms/mcp/:name', async ({ params }) => handlers.atoms.removeMcpAtom({ name: params.name }), {
      params: packParams,
      response: { 200: okResponseSchema, 404: httpErrorSchema },
      detail: { summary: 'Remove an MCP server', description: 'Deletes the atoms/mcp/<name>.json (hot).' }
    });
}
