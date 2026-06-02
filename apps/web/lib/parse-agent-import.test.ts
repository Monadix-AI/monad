import { expect, test } from 'bun:test';

import { parseClaudeSubagent } from './parse-agent-import.ts';

test('parses a full Claude Code subagent', () => {
  const md = `---
name: code-reviewer
description: Use right after writing code.
model: sonnet
tools: Read, Grep, Bash
---
You are a senior code reviewer.
Be concise.`;
  expect(parseClaudeSubagent(md)).toEqual({
    name: 'code-reviewer',
    description: 'Use right after writing code.',
    model: 'sonnet',
    prompt: 'You are a senior code reviewer.\nBe concise.'
  });
});

test('name only — description/model optional', () => {
  const md = '---\nname: minimal\n---\nbody here';
  expect(parseClaudeSubagent(md)).toEqual({
    name: 'minimal',
    description: undefined,
    model: undefined,
    prompt: 'body here'
  });
});

test('strips quotes and trailing line comments on unquoted values', () => {
  const md = `---\nname: "My Agent"\nmodel: sonnet # the cheap one\n---\nx`;
  const r = parseClaudeSubagent(md);
  expect(r.name).toBe('My Agent');
  expect(r.model).toBe('sonnet');
});

test('tolerates a BOM and leading blank lines', () => {
  const md = '﻿\n\n---\nname: bom\n---\nbody';
  expect(parseClaudeSubagent(md).name).toBe('bom');
});

test('throws without frontmatter', () => {
  expect(() => parseClaudeSubagent('just a prompt, no fence')).toThrow(/frontmatter/i);
});

test('throws without a name', () => {
  expect(() => parseClaudeSubagent('---\ndescription: no name\n---\nbody')).toThrow(/name/i);
});
