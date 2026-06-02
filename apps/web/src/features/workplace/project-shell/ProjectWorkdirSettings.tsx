import { ProjectCwdChip } from '#/features/shell/ProjectCwdChip';

export interface ProjectWorkdirSettingsProps {
  labels: {
    description: string;
    empty: string;
    title: string;
  };
  path?: string;
}

export function ProjectWorkdirSettings({ labels, path }: ProjectWorkdirSettingsProps): React.ReactElement {
  return (
    <section
      aria-labelledby="project-workdir-settings-heading"
      className="flex flex-col gap-2"
    >
      <div>
        <h3
          className="m-0 font-semibold text-[15px] text-foreground"
          id="project-workdir-settings-heading"
        >
          {labels.title}
        </h3>
        <p className="mt-1 mb-0 max-w-xl text-muted-foreground text-xs leading-relaxed">{labels.description}</p>
      </div>
      {path ? <ProjectCwdChip path={path} /> : <span className="text-muted-foreground text-xs">{labels.empty}</span>}
    </section>
  );
}
