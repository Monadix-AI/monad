import type {
  InstallMcpAtomRequest,
  InstallMcpAtomResponse,
  InstallMcpBinaryRequest,
  ListInstalledMcpAtomsResponse,
  OkResponse
} from '@monad/protocol';
import type { AtomPacksDeps } from '@/handlers/atom-pack/atom-pack-manager.ts';

import { loadAuth } from '@monad/home';

import {
  createReleaseAssetFetcher,
  installMcpBinary as installMcpBinaryService
} from '@/capabilities/mcp/install/binary.ts';
import {
  installMcpAtom as installMcpAtomService,
  listInstalledMcpAtoms,
  removeMcpAtom,
  setMcpAtomEnabled
} from '@/capabilities/mcp/install/index.ts';
import { resolveToken } from '@/handlers/atom-pack/atom-pack-shared.ts';

export function createMcpModule(deps: AtomPacksDeps) {
  const mcp = {
    // ── registry-style MCP atoms (atoms/mcp/) ───────────────────────────────────
    // onChanged → rediscovery reconnects file MCP, so an install/remove connects/drops it hot.

    async listMcpAtoms(): Promise<ListInstalledMcpAtomsResponse> {
      return { servers: await listInstalledMcpAtoms(deps.paths.mcp) };
    },

    async installMcpAtom({ server, consent }: InstallMcpAtomRequest): Promise<InstallMcpAtomResponse> {
      const out = await installMcpAtomService(server, {
        mcpDir: deps.paths.mcp,
        consent: () => consent === true
      });
      if (!out.needsConsent) await deps.onChanged?.();
      return { name: out.name, warnings: out.warnings, ...(out.needsConsent ? { needsConsent: true } : {}) };
    },

    async installMcpBinary(req: InstallMcpBinaryRequest): Promise<InstallMcpAtomResponse> {
      const auth = await loadAuth(deps.paths.auth);
      const out = await installMcpBinaryService(
        req.name,
        { owner: req.owner, repo: req.repo, tag: req.tag },
        {
          mcpDir: deps.paths.mcp,
          fetch: createReleaseAssetFetcher({ githubToken: resolveToken(auth?.atomRegistries?.github?.token) }),
          expectedSha256: req.sha256,
          consent: () => req.consent === true,
          args: req.args,
          binName: req.binName,
          autoApproveTools: req.autoApproveTools
        }
      );
      if (!out.needsConsent) await deps.onChanged?.();
      return { name: out.name, warnings: out.warnings, ...(out.needsConsent ? { needsConsent: true } : {}) };
    },

    async setMcpAtomEnabled({ name, enabled }: { name: string; enabled: boolean }): Promise<OkResponse> {
      await setMcpAtomEnabled(deps.paths.mcp, name, enabled);
      await deps.onChanged?.(); // rediscover reconnects file MCP → the toggle takes effect hot
      return { ok: true };
    },

    async removeMcpAtom({ name }: { name: string }): Promise<OkResponse> {
      await removeMcpAtom(deps.paths.mcp, name);
      await deps.onChanged?.();
      return { ok: true };
    }
  };

  return mcp;
}
