import type { ProjectExperienceDefinition } from '../experiences/types';

import { workspaceSans as sans } from '@monad/ui/components/AgentAvatar';

import { useT } from '#/components/I18nProvider';

export function ProjectExperienceSettings({
  experiences,
  loading,
  mode,
  onChange
}: {
  experiences: readonly ProjectExperienceDefinition[];
  loading: boolean;
  mode: string;
  onChange?: (mode: string) => void;
}): React.ReactElement {
  const t = useT();
  const selectedMode = experiences.some((experience) => experience.id === mode) ? mode : (experiences[0]?.id ?? '');

  return (
    <section
      aria-labelledby="project-experience-heading"
      style={{ display: 'flex', flexDirection: 'column' }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 16,
          flexWrap: 'wrap'
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <h3
            id="project-experience-heading"
            style={{ margin: 0, fontFamily: sans, fontSize: 15, fontWeight: 650, color: 'var(--foreground)' }}
          >
            {t('web.workplace.experienceSettingsTitle')}
          </h3>
          <p
            style={{
              margin: '3px 0 0',
              maxWidth: 600,
              fontFamily: sans,
              fontSize: 12,
              lineHeight: 1.45,
              color: 'var(--muted-foreground)'
            }}
          >
            {t('web.workplace.experienceSettingsDescription')}
          </p>
        </div>
        <select
          aria-label={t('web.workplace.experienceSettingsLabel')}
          disabled={loading || experiences.length === 0 || !onChange}
          onChange={(event) => onChange?.(event.currentTarget.value)}
          style={{
            width: 190,
            minHeight: 34,
            flex: 'none',
            border: `1px solid ${'var(--border)'}`,
            borderRadius: 8,
            background: 'var(--background)',
            color: 'var(--foreground)',
            fontFamily: sans,
            fontSize: 13,
            padding: '6px 10px'
          }}
          value={selectedMode}
        >
          {experiences.length === 0 ? (
            <option value="">{loading ? t('web.common.loading') : t('web.workplace.experienceSettingsEmpty')}</option>
          ) : null}
          {experiences.map((experience) => (
            <option
              key={experience.id}
              value={experience.id}
            >
              {experience.labelKey ? t(experience.labelKey) : (experience.label ?? experience.id)}
            </option>
          ))}
        </select>
      </div>
    </section>
  );
}
