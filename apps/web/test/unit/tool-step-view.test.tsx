import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ToolStepView } from '../../src/features/session/ToolStepView.tsx';

function normalizeRadixIds(markup: string): string {
  return markup.replace(/radix-_R_[^"]+_/g, 'radix-id');
}

test('skill tool renders as a compact expandable transcript event', () => {
  const markup = renderToStaticMarkup(
    createElement(ToolStepView, {
      step: {
        id: 'tool_skill',
        input: { name: 'global:writing-plans' },
        kind: 'tool',
        output: '# Writing Plans\nInternal skill instructions',
        status: 'ok',
        tool: 'skill'
      }
    })
  );

  expect(markup).toContain('data-slot="skill-tool-event"');
  expect(markup).toContain('Use Writing Plans skill');
  expect(markup).toContain('text-base');
  expect(markup).toContain('size-5');
  expect(markup).toContain('data-slot="collapsible-trigger"');
  expect(markup).toContain('aria-expanded="false"');
  expect(markup).not.toContain('Parameters');
  expect(markup).not.toContain('Result');
  expect(markup).not.toContain('Internal skill instructions');
});

test('skill tool keeps running and error states visible without adding card chrome', () => {
  const runningMarkup = renderToStaticMarkup(
    createElement(ToolStepView, {
      step: {
        id: 'tool_skill_running',
        input: { name: 'global:impeccable' },
        kind: 'tool',
        status: 'running',
        tool: 'skill'
      }
    })
  );
  const errorMarkup = renderToStaticMarkup(
    createElement(ToolStepView, {
      step: {
        id: 'tool_skill_error',
        input: { name: 'global:impeccable' },
        kind: 'tool',
        status: 'error',
        tool: 'skill'
      }
    })
  );

  expect(runningMarkup).toContain('text-accent-blue');
  expect(runningMarkup).toContain('motion-safe:animate-pulse');
  expect(runningMarkup).toContain('aria-label="Use Impeccable skill · Running…"');
  expect(runningMarkup).toContain('aria-expanded="true"');
  expect(errorMarkup).toContain('text-destructive');
  expect(errorMarkup).toContain('aria-label="Use Impeccable skill · error"');
  expect(`${runningMarkup}${errorMarkup}`).toContain('data-slot="collapsible-trigger"');
});

test('expanded skill shows metadata and markdown body without generic parameters or result chrome', () => {
  const markup = renderToStaticMarkup(
    createElement(ToolStepView, {
      step: {
        display: {
          type: 'skill',
          name: 'global:impeccable',
          description: 'Production-grade frontend design guidance.',
          version: '3.8.0',
          metadata: { owner: 'Design Systems' },
          context: 'inline',
          body: '## Craft\nBuild the interface with care.'
        },
        id: 'tool_skill_metadata',
        input: { name: 'global:impeccable' },
        kind: 'tool',
        output: '## Craft\nBuild the interface with care.',
        status: 'running',
        tool: 'skill'
      }
    })
  );

  expect(markup).toContain('data-slot="skill-metadata"');
  expect(markup).toContain('Production-grade frontend design guidance.');
  expect(markup).toContain('3.8.0');
  expect(markup).toContain('Design Systems');
  expect(markup).toContain('Build the interface with care.');
  expect(markup).not.toContain('Parameters');
  expect(markup).not.toContain('Result');
});

test('tool calls use the flat skill event style and reveal details on expand', () => {
  const completedMarkup = renderToStaticMarkup(
    createElement(ToolStepView, {
      step: {
        id: 'tool_shell',
        input: { command: 'pwd' },
        kind: 'tool',
        output: '/workspace',
        status: 'ok',
        tool: 'shell'
      }
    })
  );
  const runningMarkup = renderToStaticMarkup(
    createElement(ToolStepView, {
      step: {
        id: 'tool_shell_running',
        input: { command: 'pwd' },
        kind: 'tool',
        status: 'running',
        tool: 'shell'
      }
    })
  );

  expect(completedMarkup).toContain('rounded-none border-0');
  expect(completedMarkup).toContain('w-fit');
  expect(completedMarkup).toContain('aria-expanded="false"');
  expect(completedMarkup).not.toContain('data-slot="badge"');
  expect(completedMarkup).not.toContain('hover:bg-muted/50');
  expect(completedMarkup).toContain('hover:text-foreground');
  expect(completedMarkup).toContain('data-expanded="false"');
  expect(completedMarkup).toContain('d="M6 9L12 15L18 9"');
  expect(completedMarkup).not.toContain('rotate-180');
  expect(completedMarkup).not.toContain('Parameters');
  expect(completedMarkup).not.toContain('Result');
  expect(runningMarkup).toContain('aria-expanded="true"');
  expect(runningMarkup).toContain('data-expanded="true"');
  expect(runningMarkup).toContain('d="M6 15L12 9L18 15"');
  expect(runningMarkup).toContain('Parameters');
});

test('tool call trigger marks itself as the viewport anchor for user toggles', () => {
  const markup = renderToStaticMarkup(
    createElement(ToolStepView, {
      step: {
        id: 'tool_anchor',
        input: { command: 'pwd' },
        kind: 'tool',
        output: '/workspace',
        status: 'ok',
        tool: 'shell'
      }
    })
  );

  expect(markup).toContain('data-virtual-list-anchor="true"');
});

test('tool error details have no colored background', () => {
  const markup = renderToStaticMarkup(
    createElement(ToolStepView, {
      step: {
        id: 'tool_error',
        kind: 'tool',
        output: 'Command failed',
        status: 'error',
        tool: 'shell'
      }
    })
  );

  expect(markup).toContain('text-destructive');
  expect(markup).not.toContain('bg-destructive/10');
});

test('concurrent tool calls preserve each child tool original rendering', () => {
  const children = [
    {
      id: 'tool_shell',
      input: { command: 'pwd' },
      kind: 'tool' as const,
      status: 'running' as const,
      tool: 'shell'
    },
    {
      id: 'tool_skill',
      input: { name: 'global:writing-plans' },
      kind: 'tool' as const,
      status: 'ok' as const,
      tool: 'skill'
    }
  ];
  const groupedMarkup = normalizeRadixIds(
    renderToStaticMarkup(
      createElement(ToolStepView, {
        step: {
          id: 'tool_group',
          kind: 'toolGroup',
          steps: children
        }
      })
    )
  );

  expect(groupedMarkup).toContain('gap-2 p-0 pt-1');

  for (const child of children) {
    const standaloneMarkup = normalizeRadixIds(renderToStaticMarkup(createElement(ToolStepView, { step: child })));
    expect(groupedMarkup).toContain(standaloneMarkup);
  }
});
