import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { ComposerInlineChip, renderComposerInlineChip } from '../../src/components/ComposerInlineChip';
import { MentionCapsule } from '../../src/components/MentionText';

test('mention, skill, and command use one inline chip component contract', () => {
  const markup = renderToStaticMarkup(
    <>
      <ComposerInlineChip
        kind="mention"
        label="Planner"
      />
      <ComposerInlineChip
        kind="skill"
        label="Deploy"
        onClick={() => {}}
      />
      <ComposerInlineChip
        kind="command"
        label="Help"
      />
    </>
  );
  const expectedClass = String(renderComposerInlineChip({ kind: 'mention', label: 'Planner' })[1].class);
  const chipClasses = [...markup.matchAll(/<(?:button|span) class="([^"]+)" data-composer-chip="[^"]+"/g)].map(
    (match) => match[1]
  );

  expect(chipClasses).toEqual([expectedClass, expectedClass, expectedClass]);
  expect([...markup.matchAll(/data-composer-chip="([^"]+)"/g)].map((match) => match[1])).toEqual([
    'mention',
    'skill',
    'command'
  ]);
  expect([...markup.matchAll(/data-composer-chip-icon="([^"]+)"/g)].map((match) => match[1])).toEqual([
    'mention',
    'skill',
    'command'
  ]);
});

test('MentionCapsule delegates to the shared inline chip component', () => {
  const markup = renderToStaticMarkup(
    <MentionCapsule
      id="acp:planner"
      name="Planner"
    />
  );

  expect(markup).toContain('data-composer-chip="mention"');
  expect(markup).toContain('data-composer-chip-icon="mention"');
  expect(markup).toContain('title="acp:planner"');
});
