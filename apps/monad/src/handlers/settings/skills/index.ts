import type { MonadAuth, MonadConfig } from '@monad/environment';
import type { SetSkillsSettingsRequest, SkillsSettingsResponse } from '@monad/protocol';
import type { ConfigAccess } from '#/config/manager.ts';

function resolveUsableInstallReviewModel(cfg: MonadConfig, _auth: MonadAuth | null): string | null {
  const profiles = [
    ...cfg.model.profiles.filter((p) => p.alias === 'default'),
    ...cfg.model.profiles.filter((p) => p.alias !== 'default')
  ];
  for (const profile of profiles) {
    const provider = cfg.model.providers.find((p) => p.id === profile.routes.chat.provider);
    if (!provider) continue;
    if (provider.credentials.some((credential) => credential.authType !== 'admin_api_key')) {
      return profile.alias;
    }
  }
  return null;
}

export function createSkillsSettingsModule(config: ConfigAccess) {
  async function getSkillsSettings(): Promise<SkillsSettingsResponse> {
    const { cfg, auth } = config.get();
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
    const { cfg, auth } = config.get();
    const installReviewAvailable = resolveUsableInstallReviewModel(cfg, auth) !== null;

    await config.updateConfig((draft) => {
      if (req.autoload !== undefined) draft.skills.autoload = req.autoload;
      if (req.disabled !== undefined) draft.skills.disabled = req.disabled;
      if (req.autoloadDisabled !== undefined) draft.skills.autoloadDisabled = req.autoloadDisabled;
      if (req.installReview !== undefined) {
        if (req.installReview && !installReviewAvailable) {
          throw new Error('skills: install review requires a usable model');
        }
        draft.skills.installReview = req.installReview;
      }
    });
    return getSkillsSettings();
  }

  return { getSkillsSettings, setSkillsSettings };
}
