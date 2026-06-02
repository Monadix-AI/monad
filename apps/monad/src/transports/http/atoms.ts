import type { createDaemonHandlers } from '@/handlers/handlers.ts';

import {
  checkSkillUpdatesResponseSchema,
  createSkillRequestSchema,
  createSkillResponseSchema,
  getSkillContentResponseSchema,
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
  okResponseSchema,
  setAtomPinRequestSchema,
  updateSkillContentRequestSchema,
  updateSkillRequestSchema,
  validateSkillsRequestSchema,
  validateSkillsResponseSchema
} from '@monad/protocol';
import { Elysia } from 'elysia';
import { z } from 'zod';

// HTTP-only surface: contract declared inline; reusable wire schemas come from @monad/protocol.
const packParams = z.object({ name: z.string() });
const uploadQuery = z.object({ filename: z.string().min(1), overwrite: z.string().optional() });
const skillContentQuery = z.object({ file: z.string().optional(), id: z.string().optional() });

export function createAtomsController(handlers: ReturnType<typeof createDaemonHandlers>) {
  return new Elysia({ tags: ['http-only'] })
    .get('/atoms', async () => handlers.atoms.listAtomPacks(), {
      response: { 200: listAtomPacksResponseSchema },
      detail: {
        summary: 'List installed atom packs',
        description: 'Returns installed atom packs with declared atom kinds.'
      }
    })
    .post('/atoms/install', async ({ body }) => handlers.atoms.installAtomPack(body), {
      body: installAtomPackRequestSchema,
      response: { 200: installAtomPackResponseSchema },
      detail: {
        summary: 'Install an atom pack',
        description: 'Fetch + verify + install from github:/npm:/local:. Default-deny: re-call with consent:true.'
      }
    })
    .post(
      '/atoms/:name/enable',
      async ({ params }) => handlers.atoms.setAtomPackEnabled({ name: params.name, enabled: true }),
      {
        params: packParams,
        response: { 200: okResponseSchema },
        detail: { summary: 'Enable an atom pack', description: 'Marks an installed atom pack enabled.' }
      }
    )
    .post(
      '/atoms/:name/disable',
      async ({ params }) => handlers.atoms.setAtomPackEnabled({ name: params.name, enabled: false }),
      {
        params: packParams,
        response: { 200: okResponseSchema },
        detail: {
          summary: 'Disable an atom pack',
          description: 'Marks an installed atom pack disabled (skipped on discovery).'
        }
      }
    )
    .delete('/atoms/:name', async ({ params }) => handlers.atoms.removeAtomPack({ name: params.name }), {
      params: packParams,
      response: { 200: okResponseSchema },
      detail: { summary: 'Remove an atom pack', description: 'Deletes an installed atom pack directory.' }
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
          filename: query.filename,
          bytes: new Uint8Array(await request.arrayBuffer()),
          overwrite: query.overwrite === 'true'
        }),
      {
        query: uploadQuery,
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
    .delete('/atoms/skills/:name', async ({ params }) => handlers.atoms.removeSkill({ name: params.name }), {
      params: packParams,
      response: { 200: okResponseSchema },
      detail: { summary: 'Remove a skill', description: 'Deletes an installed skill directory (hot-reloads).' }
    })
    .get(
      '/atoms/skills/:name/content',
      async ({ params, query }) =>
        handlers.atoms.getSkillContent({ name: params.name, file: query.file, id: query.id }),
      {
        params: packParams,
        query: skillContentQuery,
        response: { 200: getSkillContentResponseSchema },
        detail: { summary: 'Read a skill file', description: 'Returns the installed SKILL.md content for editing.' }
      }
    )
    .put(
      '/atoms/skills/:name/content',
      async ({ params, query, body }) =>
        handlers.atoms.updateSkillContent({ name: params.name, id: query.id, content: body.content }),
      {
        params: packParams,
        query: skillContentQuery,
        body: updateSkillContentRequestSchema,
        response: { 200: createSkillResponseSchema },
        detail: { summary: 'Edit a skill file', description: 'Replaces an installed SKILL.md after validation.' }
      }
    )
    .post(
      '/atoms/skills/:name/update',
      async ({ params, body }) => handlers.atoms.updateSkill({ name: params.name, consent: body.consent }),
      {
        params: packParams,
        body: updateSkillRequestSchema,
        response: { 200: installSkillResponseSchema },
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
    .post(
      '/atoms/mcp/:name/enable',
      async ({ params }) => handlers.atoms.setMcpAtomEnabled({ name: params.name, enabled: true }),
      {
        params: packParams,
        response: { 200: okResponseSchema },
        detail: { summary: 'Enable an MCP server', description: 'Connects the atoms/mcp atom (hot).' }
      }
    )
    .post(
      '/atoms/mcp/:name/disable',
      async ({ params }) => handlers.atoms.setMcpAtomEnabled({ name: params.name, enabled: false }),
      {
        params: packParams,
        response: { 200: okResponseSchema },
        detail: { summary: 'Disable an MCP server', description: 'Disconnects the atoms/mcp atom (hot).' }
      }
    )
    .delete('/atoms/mcp/:name', async ({ params }) => handlers.atoms.removeMcpAtom({ name: params.name }), {
      params: packParams,
      response: { 200: okResponseSchema },
      detail: { summary: 'Remove an MCP server', description: 'Deletes the atoms/mcp/<name>.json (hot).' }
    });
}
