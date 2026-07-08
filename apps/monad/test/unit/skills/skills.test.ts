import type { Event, SessionId } from '@monad/protocol';
import type { ModelMessage, ModelResult, ModelRouter } from '@/agent/index.ts';
import type { LoadedSkill } from '@/agent/loop/index.ts';
import type { Tool } from '@/capabilities/tools/types.ts';

import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId } from '@monad/protocol';

import {
  AgentLoop,
  createAgent,
  InMemoryMessageRepo,
  parseAllowedTools,
  renderShellInjections,
  renderSkillBody,
  skillInstructions,
  substituteSkillDir,
  toolMatchesAllowedPattern
} from '@/agent/index.ts';
import { createSkillTool } from '@/capabilities/tools/registry/skill.ts';
import { toolResult } from '@/capabilities/tools/types.ts';

const stubSessionRepo = { insertSession: () => {}, getSession: () => null };

const sid = () => newId('ses') as SessionId;

const skill = (over: Partial<LoadedSkill> & Pick<LoadedSkill, 'name' | 'body'>): LoadedSkill => ({
  description: `${over.name} description`,
  ...over
});

// ── skillInstructions (L1 listing) ───────────────────────────────────────────────

test('skillInstructions lists model-invocable skills and points at the skill tool', () => {
  const _out = skillInstructions([skill({ name: 'alpha', body: 'A' }), skill({ name: 'beta', body: 'B' })]);
});

test('skillInstructions excludes modelInvocable:false skills, and is empty when none remain', () => {
  expect(skillInstructions([skill({ name: 'hidden', body: 'H', modelInvocable: false })])).toBe('');
  const _out = skillInstructions([
    skill({ name: 'shown', body: 'S' }),
    skill({ name: 'hidden', body: 'H', modelInvocable: false })
  ]);
});

// ── renderSkillBody (explicit-invocation substitution) ────────────────────────────

test('renderSkillBody substitutes $ARGUMENTS, $N, and honours quotes', () => {
  expect(renderSkillBody('Fix issue $ARGUMENTS now', '123 456')).toBe('Fix issue 123 456 now');
  expect(renderSkillBody('From $0 to $1', 'React Vue')).toBe('From React to Vue');
  expect(renderSkillBody('First: $0', '"hello world" second')).toBe('First: hello world');
});

test('renderSkillBody appends ARGUMENTS when the body does not reference them', () => {
  expect(renderSkillBody('Do the task', 'extra context')).toBe('Do the task\n\nARGUMENTS: extra context');
  expect(renderSkillBody('Do the task', '')).toBe('Do the task');
});

// ── substituteSkillDir (${SKILL_DIR} → bundled-resource path) ──────────────────────

// biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal placeholder strings
test('substituteSkillDir resolves ${SKILL_DIR} and the Claude-compatible alias', () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal placeholder strings
  expect(substituteSkillDir('run ${SKILL_DIR}/scripts/x.py', '/home/.monad/skills/foo')).toBe(
    'run /home/.monad/skills/foo/scripts/x.py'
  );
  // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal placeholder strings
  expect(substituteSkillDir('see ${CLAUDE_SKILL_DIR}/ref.md', '/s/foo')).toBe('see /s/foo/ref.md');
  // No dir → placeholder removed (unanchored skill has no resources to point at).
  // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal placeholder strings
  expect(substituteSkillDir('at ${SKILL_DIR}/x', undefined)).toBe('at /x');
});

// biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal placeholder strings
test('renderSkillBody resolves ${SKILL_DIR} alongside args', () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal placeholder strings
  expect(renderSkillBody('run ${SKILL_DIR}/x.py on $ARGUMENTS', 'a.txt', '/s/foo')).toBe('run /s/foo/x.py on a.txt');
});

// ── renderShellInjections (!`cmd` dynamic context) ───────────────────────────────

test('renderShellInjections substitutes inline !`cmd` via the injected runner', async () => {
  const run = async (cmd: string) => `[${cmd}]`;
  expect(await renderShellInjections('v: !`node -v`', run)).toBe('v: [node -v]');
  expect(await renderShellInjections('a !`one`\n!`two`', run)).toBe('a [one]\n[two]');
});

test('renderShellInjections only fires at line-start/after-whitespace, and skips when absent', async () => {
  let called = 0;
  const run = async (cmd: string) => {
    called++;
    return `[${cmd}]`;
  };
  expect(await renderShellInjections('KEY=!`x`', run)).toBe('KEY=!`x`'); // not after whitespace
  expect(await renderShellInjections('plain body', run)).toBe('plain body');
  expect(called).toBe(0);
});

test('renderShellInjections replaces a failing command with a visible marker', async () => {
  const boom = async () => {
    throw new Error('nope');
  };
  expect(await renderShellInjections('x !`bad`', boom)).toBe('x [skill command failed: bad]');
});

// ── allowed-tools matching + enforcement ─────────────────────────────────────────

test('parseAllowedTools splits on whitespace and commas', () => {
  expect(parseAllowedTools('Read  Bash, file_read')).toEqual(['Read', 'Bash', 'file_read']);
});

test('toolMatchesAllowedPattern: exact, prefix glob, and Claude arg-constraint syntax', () => {
  expect(toolMatchesAllowedPattern('file_read', 'file_read')).toBe(true);
  expect(toolMatchesAllowedPattern('file_read', 'file_write')).toBe(false);
  expect(toolMatchesAllowedPattern('file_*', 'file_write')).toBe(true);
  expect(toolMatchesAllowedPattern('Bash(git:*)', 'Bash')).toBe(true);
  expect(toolMatchesAllowedPattern('shell_*', 'file_read')).toBe(false);
});

const dangerTool: Tool<unknown, string> = {
  name: 'danger.run',
  description: 'high-risk op',
  scopes: [],
  highRisk: true,
  run: async () => toolResult('ran')
};

// A scripted step is either a final text answer or a tool call the model requests.
type Step = string | { tool: string; input?: unknown };

function scriptedModel(steps: Step[]): ModelRouter {
  let i = 0;
  return {
    async *stream() {},
    async complete(): Promise<ModelResult> {
      const step = i < steps.length ? (steps[i] as Step) : 'FALLBACK';
      i++;
      if (typeof step === 'string') return { text: step, finishReason: 'stop' };
      return {
        text: '',
        toolCalls: [{ toolCallId: `tc_${i}`, toolName: step.tool, input: step.input ?? {} }],
        finishReason: 'tool-calls'
      };
    }
  };
}

function gateHarness(skills: LoadedSkill[]) {
  const events: Event[] = [];
  const loop = new AgentLoop({
    model: scriptedModel([{ tool: 'skill', input: { name: 'gitops' } }, { tool: 'danger.run', input: {} }, 'done']),
    tools: [createSkillTool(() => skills), dangerTool],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: (e) => events.push(e),
    gate: async () => ({ allow: false, reason: 'denied by human' }), // gate denies everything
    skills
  });
  const dangerResult = () =>
    events.filter((e) => e.type === 'tool.result').find((e) => e.payload.tool === 'danger.run');
  return { loop, dangerResult };
}

test('allowed-tools: loading a skill auto-approves its declared high-risk tool (bypasses the gate)', async () => {
  const { loop, dangerResult } = gateHarness([skill({ name: 'gitops', body: 'git', allowedTools: 'danger.run' })]);
  await loop.runBlock(sid(), 'go');
  expect(dangerResult()?.payload.ok).toBe(true);
  expect(dangerResult()?.payload.result).toBe('ran');
});

test('allowed-tools: without a grant the gate still denies the high-risk tool', async () => {
  const { loop, dangerResult } = gateHarness([skill({ name: 'gitops', body: 'git' })]); // no allowedTools
  await loop.runBlock(sid(), 'go');
  expect(dangerResult()?.payload.ok).toBe(false);
  expect(dangerResult()?.payload.result).toMatch(/denied by human/);
});

// ── createSkillTool (L2 loader) ───────────────────────────────────────────────────

const ctx = { sessionId: 'ses_x', log: () => {} };

test('createSkillTool returns the body for a known skill', async () => {
  const tool = createSkillTool(() => [skill({ name: 'alpha', body: 'ALPHA BODY' })]);
  expect((await tool.run({ name: 'alpha' }, ctx)).modelContent).toBe('ALPHA BODY');
});

test('createSkillTool resolves same-name skills by addressable id', async () => {
  const tool = createSkillTool(() => [
    skill({ name: 'global:summarize-changes', body: 'GLOBAL BODY' }),
    skill({ name: 'agent:default:summarize-changes', body: 'AGENT BODY' })
  ]);
  expect((await tool.run({ name: 'global:summarize-changes' }, ctx)).modelContent).toBe('GLOBAL BODY');
  expect((await tool.run({ name: 'agent:default:summarize-changes' }, ctx)).modelContent).toBe('AGENT BODY');
});

test('createSkillTool throws (listing valid names) for an unknown skill', async () => {
  const tool = createSkillTool(() => [skill({ name: 'alpha', body: 'A' })]);
  await expect(tool.run({ name: 'nope' }, ctx)).rejects.toThrow(/unknown skill "nope".*alpha/);
});

test('createSkillTool excludes modelInvocable:false skills from loading', async () => {
  const tool = createSkillTool(() => [skill({ name: 'hidden', body: 'H', modelInvocable: false })]);
  await expect(tool.run({ name: 'hidden' }, ctx)).rejects.toThrow(/unknown skill/);
});

// ── L3 bundled-resource loading via the `file` arg ───────────────────────────────

test('createSkillTool loads a bundled resource file, guards traversal, and errors clearly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'monad-skill-res-'));
  try {
    await writeFile(join(dir, 'REFERENCE.md'), '# Reference\nbundled content');
    const tool = createSkillTool(() => [skill({ name: 'docs', body: 'B', dir })]);

    // file → bundled content
    // no file → body
    expect((await tool.run({ name: 'docs' }, ctx)).modelContent).toBe('B');
    // missing file → clear error
    await expect(tool.run({ name: 'docs', file: 'NOPE.md' }, ctx)).rejects.toThrow(/no bundled file/);
    // path traversal → rejected before any fs access
    await expect(tool.run({ name: 'docs', file: '../../etc/passwd' }, ctx)).rejects.toThrow(/escapes the skill/);
    await expect(tool.run({ name: 'docs', file: '/etc/passwd' }, ctx)).rejects.toThrow(/escapes the skill/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('createSkillTool errors when a skill bundles no directory but a file is requested', async () => {
  const tool = createSkillTool(() => [skill({ name: 'nodir', body: 'B' })]);
  await expect(tool.run({ name: 'nodir', file: 'x.md' }, ctx)).rejects.toThrow(/no directory/);
});

// ── context: fork (subagent) ──────────────────────────────────────────────────────

test('createSkillTool: a fork skill runs the subagent runner and returns its result, not the body', async () => {
  const seen: Array<{ body: string; sessionId: string }> = [];
  const runFork = async (body: string, c: { sessionId: string }) => {
    seen.push({ body, sessionId: c.sessionId });
    return 'SUBAGENT RESULT';
  };
  const tool = createSkillTool(() => [skill({ name: 'research', body: 'do research', fork: true })], runFork);
  const _out = await tool.run({ name: 'research' }, ctx);

  expect(seen).toEqual([{ body: 'do research', sessionId: 'ses_x' }]);
});

test('createSkillTool: a non-fork skill returns its body even when a runner is supplied', async () => {
  const tool = createSkillTool(
    () => [skill({ name: 'plain', body: 'just text' })],
    async () => 'NOPE'
  );
  expect((await tool.run({ name: 'plain' }, ctx)).modelContent).toBe('just text');
});

test('createSkillTool: a fork skill falls back to its body when no runner is wired', async () => {
  const tool = createSkillTool(() => [skill({ name: 'research', body: 'do research', fork: true })]);
  expect((await tool.run({ name: 'research' }, ctx)).modelContent).toBe('do research');
});

test('explicit /name of a fork skill runs the subagent and returns its result (runBlock)', async () => {
  const seen: string[] = [];
  const skills = [skill({ name: 'research', body: 'Research $ARGUMENTS thoroughly.', fork: true })];
  const loop = new AgentLoop({
    model: scriptedModel(['unused']),
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {},
    skills,
    runFork: async (body) => {
      seen.push(body);
      return 'FORK DONE';
    }
  });
  const msg = await loop.runBlock(sid(), '/research caching');
  expect(msg.text).toBe('FORK DONE'); // result, not the rendered body or a model turn
  expect(seen).toEqual(['Research caching thoroughly.']); // body rendered with args, forked
});

test('createSkillTool: a fork skill forwards its declared tier to the runner', async () => {
  let seenTier: string | undefined = 'UNSET';
  const runFork = async (_body: string, _c: { sessionId: string }, tier?: string) => {
    seenTier = tier;
    return 'OK';
  };
  const tool = createSkillTool(() => [skill({ name: 'research', body: 'b', fork: true, tier: 'fast' })], runFork);
  await tool.run({ name: 'research' }, ctx);
  expect(seenTier).toBe('fast');

  // A fork skill with no tier forwards undefined (caller falls back to the default model).
  const plainTool = createSkillTool(() => [skill({ name: 'plain', body: 'b', fork: true })], runFork);
  await plainTool.run({ name: 'plain' }, ctx);
});

test('explicit /name of a fork skill forwards its tier to the runner (runBlock)', async () => {
  let seenTier: string | undefined = 'UNSET';
  const skills = [skill({ name: 'deepthink', body: 'Think about $ARGUMENTS.', fork: true, tier: 'fast' })];
  const loop = new AgentLoop({
    model: scriptedModel(['unused']),
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {},
    skills,
    runFork: async (_body, _c, tier) => {
      seenTier = tier;
      return 'DONE';
    }
  });
  await loop.runBlock(sid(), '/deepthink caching');
  expect(seenTier).toBe('fast');
});

test('createAgent resolveTier maps a fork skill tier to a model id for the subagent', async () => {
  const seen: Array<{ model: string }> = [];
  // A model router that records the model id each completion runs under, so we can assert the
  // forked subagent picked up the tier-resolved model (not the parent default).
  const recordingModel: ModelRouter = {
    async *stream() {},
    async complete(req: { model: string }): Promise<ModelResult> {
      seen.push({ model: req.model });
      return { text: 'sub-done', finishReason: 'stop' };
    }
  };

  const agent = createAgent({
    model: recordingModel,
    sessionRepo: stubSessionRepo,
    defaultModel: 'parent-default',
    skills: [skill({ name: 'research', body: 'do it', fork: true, tier: 'fast' })],
    resolveTier: (tier) => (tier === 'fast' ? 'fast-model' : undefined)
  });

  const loop = agent.loop(() => {});
  await loop.runBlock(sid(), '/research');
  expect(seen.some((s) => s.model === 'fast-model')).toBe(true); // resolved, not 'parent-default'
});

test('createSkillTool reads its skill set live (hot reload: in-place array mutation)', async () => {
  const live: LoadedSkill[] = [skill({ name: 'one', body: 'ONE' })];
  const tool = createSkillTool(() => live);
  expect((await tool.run({ name: 'one' }, ctx)).modelContent).toBe('ONE');
  await expect(tool.run({ name: 'two' }, ctx)).rejects.toThrow(/unknown skill/);

  // Simulate the watcher replacing the contents in place.
  live.splice(0, live.length, skill({ name: 'two', body: 'TWO' }));
  expect((await tool.run({ name: 'two' }, ctx)).modelContent).toBe('TWO');
  await expect(tool.run({ name: 'one' }, ctx)).rejects.toThrow(/unknown skill/);
});

// ── L1 injection through the loop ─────────────────────────────────────────────────

/** A model that records the prompt it receives, then answers with plain prose. */
function recordingModel(sink: ModelMessage[][]): ModelRouter {
  return {
    async *stream() {},
    async complete(req): Promise<ModelResult> {
      sink.push(req.messages);
      return { text: 'done', finishReason: 'stop' };
    }
  };
}

test('buildPrompt injects the skill listing into the system prompt when tools are present', async () => {
  const prompts: ModelMessage[][] = [];
  const skills = [skill({ name: 'alpha', body: 'A' })];
  const loop = new AgentLoop({
    model: recordingModel(prompts),
    tools: [createSkillTool(() => skills)],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {},
    skills
  });
  await loop.runBlock(sid(), 'hi');

  const system = (prompts[0] as ModelMessage[])[0];
  expect(system?.role).toBe('system');
});

// ── createAgent wiring ────────────────────────────────────────────────────────────

test('createAgent appends the skill tool when a model-invocable skill exists', () => {
  const agent = createAgent({ sessionRepo: stubSessionRepo, skills: [skill({ name: 'alpha', body: 'A' })] });
  expect(agent.tools.some((t) => t.name === 'skill')).toBe(true);
});

test('createAgent omits the skill tool when all skills are user-only', () => {
  const agent = createAgent({
    sessionRepo: stubSessionRepo,
    skills: [skill({ name: 'x', body: 'X', modelInvocable: false })]
  });
  expect(agent.tools.some((t) => t.name === 'skill')).toBe(false);
});

// ── explicit /name invocation ─────────────────────────────────────────────────────

function harness(skills: LoadedSkill[]) {
  const prompts: ModelMessage[][] = [];
  const messages = new InMemoryMessageRepo();
  const loop = new AgentLoop({
    model: recordingModel(prompts),
    tools: [],
    messages,
    defaultModel: 'mock',
    emit: () => {},
    skills
  });
  return { loop, messages, prompts };
}

function _lastUserContent(msgs: ModelMessage[]): string {
  const m = [...msgs].reverse().find((msg) => msg.role === 'user');
  const c = m?.content;
  if (typeof c === 'string') return c;
  return ((c as Array<{ type: string; text?: string }> | undefined) ?? []).map((p) => p.text ?? '').join('');
}

function userContents(msgs: ModelMessage[]): string[] {
  return msgs
    .filter((msg) => msg.role === 'user')
    .map((msg) => {
      if (typeof msg.content === 'string') return msg.content;
      return ((msg.content as Array<{ type: string; text?: string }> | undefined) ?? [])
        .map((p) => p.text ?? '')
        .join('');
    });
}

test('/name stores raw command in history; expanded body reaches the model for that turn', async () => {
  const { loop, messages } = harness([skill({ name: 'fix-issue', body: 'Fix issue $ARGUMENTS carefully.' })]);
  const s = sid();
  await loop.runBlock(s, '/fix-issue 42');

  const user = messages.list(s).find((m) => m.role === 'user');
  expect(user?.text).toBe('/fix-issue 42');
  expect(user?.data).toEqual({
    modelInput: { kind: 'skill', skillName: 'fix-issue', text: 'Fix issue 42 carefully.' }
  });
});

test('/name replays the rendered skill body on later turns, not the raw slash command', async () => {
  const { loop, prompts } = harness([skill({ name: 'fix-issue', body: 'Fix issue $ARGUMENTS carefully.' })]);
  const s = sid();
  await loop.runBlock(s, '/fix-issue 42');
  await loop.runBlock(s, 'next turn');

  const _users = userContents(prompts[1] ?? []);
});

test('/name is left literal for a user-invocable:false skill', async () => {
  const { loop, messages } = harness([skill({ name: 'secret', body: 'hidden body', userInvocable: false })]);
  const s = sid();
  await loop.runBlock(s, '/secret');

  const user = messages.list(s).find((m) => m.role === 'user');
  expect(user?.text).toBe('/secret');
});

test('a disableModelInvocation skill is still explicitly invocable via /name', async () => {
  const { loop, messages } = harness([
    skill({ name: 'deploy', body: 'Deploy to $0.', modelInvocable: false, userInvocable: true })
  ]);
  const s = sid();
  await loop.runBlock(s, '/deploy prod');

  const user = messages.list(s).find((m) => m.role === 'user');
  expect(user?.text).toBe('/deploy prod');
});

test('an unknown /name is left literal (treated as a normal prompt)', async () => {
  const { loop, messages } = harness([skill({ name: 'alpha', body: 'A' })]);
  const s = sid();
  await loop.runBlock(s, '/unknown thing');

  const user = messages.list(s).find((m) => m.role === 'user');
  expect(user?.text).toBe('/unknown thing');
});
