import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertValidAgentDir,
  composeAgentMd,
  deleteAgentDir,
  loadAgentBody,
  parseAgentMd,
  toAgentDir,
  writeAgentBody
} from '@/store/home/agent-def.ts';

describe('parseAgentMd', () => {
  test('parses frontmatter + body', () => {
    const { frontmatter, body } = parseAgentMd(
      '---\nname: research-bot\ndescription: Use for deep research\nmodel: inherit\n---\n\nYou are a researcher.'
    );
    expect(frontmatter?.name).toBe('research-bot');
    expect(frontmatter?.description).toBe('Use for deep research');
    expect(frontmatter?.model).toBe('inherit');
    expect(body).toBe('You are a researcher.');
  });

  test('body-only file (no fence) is valid, no frontmatter', () => {
    const { frontmatter, body } = parseAgentMd('Just a system prompt, no frontmatter.\n');
    expect(frontmatter).toBeNull();
    expect(body).toBe('Just a system prompt, no frontmatter.');
  });

  test('normalises a YAML list of tools to a string', () => {
    const { frontmatter } = parseAgentMd('---\nname: t\ntools:\n  - Read\n  - Grep\n---\nbody');
    expect(frontmatter?.tools).toBe('Read, Grep');
  });

  test('accepts disallowed-tools kebab alias', () => {
    const { frontmatter } = parseAgentMd('---\nname: t\ndisallowed-tools: Write, Edit\n---\nbody');
    expect(frontmatter?.disallowedTools).toBe('Write, Edit');
  });

  test('rejects malformed YAML frontmatter', () => {
    expect(() => parseAgentMd('---\nname: [unclosed\n---\nbody')).toThrow(/invalid YAML|invalid AGENT.md/);
  });
});

describe('composeAgentMd round-trips through parseAgentMd', () => {
  test('name + description + body survive', () => {
    const md = composeAgentMd({ name: 'My Agent', description: 'does things' }, 'Hello\n\nworld');
    const { frontmatter, body } = parseAgentMd(md);
    expect(frontmatter?.name).toBe('My Agent');
    expect(frontmatter?.description).toBe('does things');
    expect(body).toBe('Hello\n\nworld');
  });
});

describe('toAgentDir / assertValidAgentDir', () => {
  test('slugifies free-text names', () => {
    expect(toAgentDir('Research Bot 2!')).toBe('research-bot-2');
    expect(toAgentDir('  --Weird__Name--  ')).toBe('weird-name');
    expect(toAgentDir('!!!')).toBe('agent');
  });

  test('valid slugs pass, traversal/invalid reject', () => {
    expect(() => assertValidAgentDir('research-bot')).not.toThrow();
    expect(() => assertValidAgentDir('../escape')).toThrow();
    expect(() => assertValidAgentDir('has/slash')).toThrow();
    expect(() => assertValidAgentDir('Upper')).toThrow();
  });
});

describe('writeAgentBody / loadAgentBody / deleteAgentDir', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'monad-agents-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('write then load returns the body only', async () => {
    await writeAgentBody(dir, 'research-bot', { name: 'Research Bot', description: 'd' }, 'Be thorough.');
    expect(await loadAgentBody(dir, 'research-bot')).toBe('Be thorough.');
  });

  test('absent agent dir loads as undefined (valid empty-prompt agent)', async () => {});

  test('delete removes the dir, load then undefined', async () => {
    await writeAgentBody(dir, 'temp', { name: 'Temp' }, 'x');
    await deleteAgentDir(dir, 'temp');
  });

  test('traversal dir rejected on write', async () => {
    await expect(writeAgentBody(dir, '../escape', { name: 'x' }, 'y')).rejects.toThrow();
  });
});
