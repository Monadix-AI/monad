import type { ModelRequest, ModelResult, ModelRouter } from '@/agent/model/index.ts';

import { expect, test } from 'bun:test';

import {
  reviewSkillInstall,
  type SkillInstallReviewWarning,
  warningToString
} from '@/capabilities/skills/install/review.ts';

const promptContent = (
  await Bun.file(
    new URL('../../../src/capabilities/skills/install/prompts/skill-install-review-prompt.md', import.meta.url)
  ).text()
).trim();

function modelReply(text: string, capture?: (req: ModelRequest) => void): ModelRouter {
  return {
    async complete(req): Promise<ModelResult> {
      capture?.(req);
      return { text };
    },
    async *stream() {}
  };
}

function warningsToStrings(warnings: SkillInstallReviewWarning[]): string[] {
  return warnings.map(warningToString);
}

const files = new Map([
  ['demo/SKILL.md', new TextEncoder().encode('---\nname: demo\ndescription: useful\n---\nHelp user.')]
]);

test('skill install review allows a clean model verdict', async () => {
  let capturedReq: ModelRequest | undefined;
  const warnings = await reviewSkillInstall({
    files,
    model: modelReply('{"risky":false,"reason":"clean"}', (req) => {
      capturedReq = req;
    }),
    modelSpec: 'default',
    skills: ['demo'],
    source: 'clawhub:demo'
  });

  expect(capturedReq?.messages[0]?.role).toBe('system');
  expect(capturedReq?.messages[0]?.content).toContain(promptContent);
});

test('skill install review turns risky or unreadable verdicts into warnings', async () => {
  const risky = await reviewSkillInstall({
    files,
    model: modelReply('{"risky":true,"reason":"tries to override system instructions"}'),
    modelSpec: 'default',
    skills: ['demo'],
    source: 'clawhub:demo'
  });
  const unreadable = await reviewSkillInstall({
    files,
    model: modelReply('not json'),
    modelSpec: 'default',
    skills: ['demo'],
    source: 'clawhub:demo'
  });

  expect(warningsToStrings(risky)).toEqual([
    'install review flagged this skill: tries to override system instructions'
  ]);
  expect(warningsToStrings(unreadable)).toEqual(['install review failed: model returned invalid JSON']);
});

test('skill install review exposes no readable text and model-request failure as typed warnings', async () => {
  const noReadableText = await reviewSkillInstall({
    files: new Map(),
    model: modelReply('{"risky":false,"reason":"clean"}'),
    modelSpec: 'default',
    skills: ['demo'],
    source: 'clawhub:demo'
  });
  const requestFailed = await reviewSkillInstall({
    files,
    model: {
      async complete(): Promise<ModelResult> {
        throw new Error('provider offline');
      },
      async *stream() {}
    },
    modelSpec: 'default',
    skills: ['demo'],
    source: 'clawhub:demo'
  });

  expect(warningsToStrings(noReadableText)).toEqual(['install review failed: no readable text']);
  expect(warningsToStrings(requestFailed)).toEqual(['install review failed: model request failed: provider offline']);
});
