import type { InstallSkillRequest, InstallSkillResponse } from '@monad/protocol';
import type { SkillInstallReviewer } from '@/capabilities/skills/install/index.ts';
import type { AtomPacksDeps } from '@/handlers/atom-pack/atom-pack-manager.ts';

import { loadAuth } from '@monad/home';

import { installClawHubSkill } from '@/capabilities/skills/install/clawhub.ts';
import { createSkillFetcher } from '@/capabilities/skills/install/fetch.ts';
import { installGitSkill } from '@/capabilities/skills/install/git.ts';
import { installSkill as installSkillFromGithub } from '@/capabilities/skills/install/index.ts';
import { installHttpSkill } from '@/capabilities/skills/install/tarball.ts';
import { SAFE_NAME } from '@/handlers/atom-pack/atom-pack-content.ts';
import { resolveToken } from '@/handlers/atom-pack/atom-pack-shared.ts';
import {
  isDefaultMarketplaceSourceSpec,
  isGithubHttpSource,
  readSkillRecord
} from '@/handlers/atom-pack/atom-pack-skill-source.ts';
import { HandlerError } from '@/handlers/handler-error.ts';

interface SkillInstallerDeps {
  reviewInstall: SkillInstallReviewer;
  reloadAfterSkillCommit: <T extends InstallSkillResponse>(out: T) => Promise<T>;
}

export function createSkillInstallers(
  deps: AtomPacksDeps,
  { reviewInstall, reloadAfterSkillCommit }: SkillInstallerDeps
) {
  return {
    async installSkill({ source, consent, overwrite }: InstallSkillRequest): Promise<InstallSkillResponse> {
      if (source.startsWith('git+')) {
        const out = await installGitSkill(source, {
          skillsDir: deps.paths.skills,
          skillsLock: deps.paths.skillsLock,
          consent: () => consent === true,
          review: reviewInstall,
          overwrite
        });
        return reloadAfterSkillCommit({
          skills: out.skills,
          commit: out.commit,
          warnings: out.warnings,
          ...(out.needsConsent ? { needsConsent: true } : {})
        });
      }
      if ((source.startsWith('https://') || source.startsWith('http://')) && !isGithubHttpSource(source)) {
        const out = await installHttpSkill(source, {
          skillsDir: deps.paths.skills,
          skillsLock: deps.paths.skillsLock,
          consent: () => consent === true,
          review: reviewInstall,
          overwrite
        });
        return reloadAfterSkillCommit({
          skills: out.skills,
          commit: '',
          warnings: out.warnings,
          ...(out.needsConsent ? { needsConsent: true } : {})
        });
      }
      if (isDefaultMarketplaceSourceSpec(source)) {
        const out = await installClawHubSkill(source, {
          skillsDir: deps.paths.skills,
          skillsLock: deps.paths.skillsLock,
          consent: () => consent === true,
          review: reviewInstall,
          overwrite
        });
        return reloadAfterSkillCommit({
          skills: out.skills,
          commit: '',
          warnings: out.warnings,
          ...(out.needsConsent ? { needsConsent: true } : {})
        });
      }
      const auth = await loadAuth(deps.paths.auth);
      const out = await installSkillFromGithub(source, {
        skillsDir: deps.paths.skills,
        fetch: createSkillFetcher({ githubToken: resolveToken(auth?.atomRegistries?.github?.token) }),
        consent: () => consent === true,
        review: reviewInstall,
        overwrite
      });
      return reloadAfterSkillCommit({
        skills: out.skills,
        commit: out.commit,
        warnings: out.warnings,
        ...(out.needsConsent ? { needsConsent: true } : {})
      });
    },

    // Re-install a skill from its recorded source (overwrite) — i.e. pull the ref's current head.
    // A hand-dropped skill (no install record) has nothing to update from.
    async updateSkill({ name, consent }: { name: string; consent?: boolean }): Promise<InstallSkillResponse> {
      if (!SAFE_NAME.test(name)) throw new HandlerError('invalid', `invalid skill name: ${name}`);
      const rec = await readSkillRecord(deps.paths.skills, name);
      if (!rec?.source) throw new HandlerError('invalid', `skill "${name}" has no recorded source to update from`);
      const source = rec.source;
      if (source.startsWith('git+')) {
        const out = await installGitSkill(source, {
          skillsDir: deps.paths.skills,
          skillsLock: deps.paths.skillsLock,
          consent: () => consent === true,
          review: reviewInstall,
          overwrite: true
        });
        return reloadAfterSkillCommit({
          skills: out.skills,
          commit: out.commit,
          warnings: out.warnings,
          ...(out.needsConsent ? { needsConsent: true } : {})
        });
      }
      if (source.startsWith('https://') || source.startsWith('http://')) {
        const out = await installHttpSkill(source, {
          skillsDir: deps.paths.skills,
          skillsLock: deps.paths.skillsLock,
          consent: () => consent === true,
          review: reviewInstall,
          overwrite: true
        });
        return reloadAfterSkillCommit({
          skills: out.skills,
          commit: '',
          warnings: out.warnings,
          ...(out.needsConsent ? { needsConsent: true } : {})
        });
      }
      if (isDefaultMarketplaceSourceSpec(source)) {
        const out = await installClawHubSkill(source, {
          skillsDir: deps.paths.skills,
          skillsLock: deps.paths.skillsLock,
          consent: () => consent === true,
          review: reviewInstall,
          overwrite: true
        });
        return reloadAfterSkillCommit({
          skills: out.skills,
          commit: '',
          warnings: out.warnings,
          ...(out.needsConsent ? { needsConsent: true } : {})
        });
      }
      const auth = await loadAuth(deps.paths.auth);
      const out = await installSkillFromGithub(source, {
        skillsDir: deps.paths.skills,
        fetch: createSkillFetcher({ githubToken: resolveToken(auth?.atomRegistries?.github?.token) }),
        consent: () => consent === true,
        review: reviewInstall,
        overwrite: true
      });
      return reloadAfterSkillCommit({
        skills: out.skills,
        commit: out.commit,
        warnings: out.warnings,
        ...(out.needsConsent ? { needsConsent: true } : {})
      });
    }
  };
}
