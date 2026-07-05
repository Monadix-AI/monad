import { expect, test } from 'bun:test';
import { join } from 'node:path';

import {
  getProjectExperience,
  listProjectExperiences,
  toProjectExperienceDefinitions
} from '../../features/workplace/experiences/registry.ts';

const repoFile = (path: string) => Bun.file(join(import.meta.dir, '../../../..', path));

test('project experiences: built-in atom descriptors expose full runtime-switchable project experiences', () => {
  const experiences = listProjectExperiences(
    toProjectExperienceDefinitions([
      {
        id: 'primary-view',
        title: 'Primary',
        icon: 'message-square',
        entry: { type: 'host-component', component: 'primary-view' }
      },
      {
        id: 'secondary-view',
        title: 'Secondary',
        icon: 'git-fork',
        entry: { type: 'host-component', component: 'secondary-view' }
      }
    ])
  );

  expect(experiences.map((experience) => experience.id)).toEqual(['primary-view', 'secondary-view']);
  expect(getProjectExperience('secondary-view', experiences)?.id).toBe('secondary-view');
  expect(getProjectExperience('missing', experiences)?.id).toBe('primary-view');
});

test('project experiences: workspace-experience atoms join the runtime-switchable registry', () => {
  const atoms = toProjectExperienceDefinitions([
    {
      id: 'primary-view',
      title: 'Primary',
      icon: 'message-square',
      entry: { type: 'host-component', component: 'primary-view' }
    },
    {
      id: 'secondary-view',
      title: 'Secondary',
      icon: 'git-fork',
      entry: { type: 'host-component', component: 'secondary-view' }
    },
    {
      id: 'custom-canvas',
      title: 'Custom Canvas',
      entry: { type: 'web-component', module: '/atoms/packs/custom/canvas.js', tagName: 'custom-canvas' }
    }
  ]);
  const experiences = listProjectExperiences(atoms);

  expect(experiences.map((experience) => experience.id)).toEqual(['primary-view', 'secondary-view', 'custom-canvas']);
  expect(getProjectExperience('custom-canvas', experiences)).toMatchObject({
    id: 'custom-canvas',
    label: 'Custom Canvas'
  });
  expect(getProjectExperience('secondary-view', experiences)?.id).toBe('secondary-view');
  expect(getProjectExperience('missing', experiences)?.id).toBe('primary-view');
});

test('built-in workspace experience host supplies the ambient host context', async () => {
  const source = await repoFile(
    'apps/web/features/workplace/experiences/builtin/BuiltinWorkspaceExperience.tsx'
  ).text();

  expect(source).toContain("from '@monad/atoms/workspace-experiences/host-context'");
  expect(source).toContain('<WorkspaceExperienceHostProvider');
  expect(source).toContain('</WorkspaceExperienceHostProvider>');
  expect(source).toContain('openStudio:');
  expect(source).toContain('requestProjectDialog:');
});

test('workspace experience canvas shows monad loading while experiences are pending', async () => {
  const routeSource = await repoFile('apps/web/features/routes/workspace/WorkspaceRoute.tsx').text();
  const workplaceSource = await repoFile('apps/web/features/workplace/Workplace.tsx').text();
  const rendererSource = await repoFile(
    'apps/web/features/workplace/experiences/WorkspaceExperienceRenderer.tsx'
  ).text();

  expect(routeSource).toContain('isLoading: workspaceExperiencesLoading');
  expect(routeSource).toContain('experiencesLoading={workspaceExperiencesLoading}');
  expect(workplaceSource).toContain("import { MonadLoading } from '@/features/init/MonadLoading'");
  expect(workplaceSource).toContain('experiencesLoading?: boolean');
  expect(workplaceSource).toContain('<MonadLoading');
  expect(rendererSource).toContain("import { MonadLoading } from '@/features/init/MonadLoading'");
  expect(rendererSource).toContain('fallback={<WorkspaceExperienceLoading />}');
});

test('project workspace route keeps session-only chat dependencies out of the initial shell', async () => {
  const source = await repoFile('apps/web/features/shell/AppShellRoutes.tsx').text();

  expect(source).not.toContain('import { SessionRoute }');
  expect(source).toContain("dynamic(() => import('@/features/routes/sessions/SessionRoute')");
});

test('chat workspace experience does not statically load graph view dependencies', async () => {
  const source = await repoFile('packages/atoms/src/workspace-experiences/ui.tsx').text();

  expect(source).not.toContain('import { renderGraphViewWorkspaceExperience }');
  expect(source).toContain("import('./graph-view/ui.tsx')");
});

test('empty chat workspace experience avoids loading message rendering stack', async () => {
  const source = await repoFile(
    'packages/atoms/src/workspace-experiences/chat-room/components/chat-transcript.tsx'
  ).text();

  expect(source).not.toContain('import { VirtualList');
  expect(source).not.toContain('import { MessageRow }');
  expect(source).toContain("import('./message-list.tsx')");
  expect(source).toContain('fallback={<MessageListSkeleton />}');
});

test('markdown entrypoint defers streamdown parser dependencies', async () => {
  const source = await repoFile('packages/ui/src/components/Markdown.tsx').text();

  expect(source).not.toContain("import { type Components, Streamdown } from 'streamdown'");
  expect(source).not.toContain("from '@streamdown/mermaid'");
  expect(source).toContain("import('./MarkdownRenderer.tsx')");
});
