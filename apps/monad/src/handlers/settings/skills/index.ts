import type { MonadAuth, MonadConfig, MonadPaths } from '@monad/home';
import type { SetSkillsSettingsRequest, SkillsSettingsResponse } from '@monad/protocol';
import type { ConfigBus } from '#/services/config-bus.ts';

import { DEFAULT_SAMPLE_PROVIDER_ID, loadAll, loadAuth, saveProfile } from '@monad/home';

function resolveUsableInstallReviewModel(cfg: MonadConfig, auth: MonadAuth | null): string | null {
  if (!auth) return null;
  const profiles = [
    ...cfg.model.profiles.filter((p) => p.alias === 'default'),
    ...cfg.model.profiles.filter((p) => p.alias !== 'default')
  ];
  for (const profile of profiles) {
    const provider = cfg.model.providers.find((p) => p.id === profile.routes.chat.provider);
    if (!provider || provider.id === DEFAULT_SAMPLE_PROVIDER_ID) continue;
    if ((auth.credentialPool[provider.id] ?? []).some((credential) => credential.authType !== 'admin_api_key')) {
      return profile.alias;
    }
  }
  return null;
}

export function createSkillsSettingsModule(paths: MonadPaths, configBus?: ConfigBus) {
  async function getSkillsSettings(): Promise<SkillsSettingsResponse> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('skills: config.json missing');
    const auth = await loadAuth(paths.auth);
    const installReviewAvailable = resolveUsableInstallReviewModel(cfg, auth) !== null;
    return {
      autoload: cfg.skills.autoload,
      disabled: cfg.skills.disabled,
      autoloadDisabled: cfg.skills.autoloadDisabled,
      installReview: cfg.skills.installReview && installReviewAvailable,
      installReviewAvailable
    };
  }

  async function setSkillsSettings(req: SetSkillsSettingsRequest): Promise<SkillsSettingsResponse> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('skills: config.json missing');
    const auth = await loadAuth(paths.auth);
    const installReviewAvailable = resolveUsableInstallReviewModel(cfg, auth) !== null;

    if (req.autoload !== undefined) cfg.skills.autoload = req.autoload;
    if (req.disabled !== undefined) cfg.skills.disabled = req.disabled;
    if (req.autoloadDisabled !== undefined) cfg.skills.autoloadDisabled = req.autoloadDisabled;
    if (req.installReview !== undefined) {
      if (req.installReview && !installReviewAvailable) {
        throw new Error('skills: install review requires a usable model');
      }
      cfg.skills.installReview = req.installReview;
    }

    await saveProfile(paths.profile, cfg);
    if (configBus) {
      await configBus.publish({ cfg, auth });
    }
    return getSkillsSettings();
  }

  return { getSkillsSettings, setSkillsSettings };
}
