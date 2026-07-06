import { expect, test } from 'bun:test';

import { CLIENT_VERSION, isVersionCompatible } from '../../src/version.ts';

// ── CLIENT_VERSION ─────────────────────────────────────────────────────────────

test('CLIENT_VERSION: is a semver-like string', () => {
  expect(CLIENT_VERSION).toMatch(/^\d+\.\d+\.\d+/);
});

// ── isVersionCompatible: pre-release (0.x.y) ──────────────────────────────────

test('0.x.y: matching major and minor is compatible', () => {
  const result = isVersionCompatible('0.5.3', '0.5.0');
  expect(result.compatible).toBe(true);
});

test('0.x.y: matching major and minor patch mismatch is compatible', () => {
  expect(isVersionCompatible('0.10.99', '0.10.0').compatible).toBe(true);
});

test('0.x.y: minor mismatch is incompatible', () => {
  const result = isVersionCompatible('0.5.0', '0.6.0');
  expect(result.compatible).toBe(false);
  expect(result.reason).toContain('incompatible');
  expect(result.daemonVersion).toBe('0.5.0');
  expect(result.clientVersion).toBe('0.6.0');
});

test('0.x.y: major mismatch (0 vs 1) is incompatible', () => {
  expect(isVersionCompatible('0.5.0', '1.5.0').compatible).toBe(false);
});

// ── isVersionCompatible: stable (1.x.y+) ─────────────────────────────────────

test('1.x.y: same major is compatible regardless of minor/patch', () => {
  expect(isVersionCompatible('1.0.0', '1.5.3').compatible).toBe(true);
  expect(isVersionCompatible('1.99.0', '1.0.1').compatible).toBe(true);
});

test('2.x.y: same major is compatible', () => {
  expect(isVersionCompatible('2.3.4', '2.0.0').compatible).toBe(true);
});

test('stable: major mismatch is incompatible', () => {
  const result = isVersionCompatible('1.5.0', '2.0.0');
  expect(result.compatible).toBe(false);
  expect(result.reason).toContain('incompatible');
});

test('stable: version with pre-release suffix is parsed correctly', () => {
  // parseSemver only cares about the leading digits
  expect(isVersionCompatible('1.0.0-alpha.1', '1.2.3').compatible).toBe(true);
});

// ── isVersionCompatible: error cases ──────────────────────────────────────────

test('unparseable daemon version returns incompatible with reason', () => {
  const result = isVersionCompatible('not-a-version', '1.0.0');
  expect(result.compatible).toBe(false);
  expect(result.reason).toBe('unparseable version string');
});

test('unparseable client version returns incompatible with reason', () => {
  const result = isVersionCompatible('1.0.0', 'nope');
  expect(result.compatible).toBe(false);
  expect(result.reason).toBe('unparseable version string');
});

test('empty string returns incompatible', () => {
  expect(isVersionCompatible('', '1.0.0').compatible).toBe(false);
  expect(isVersionCompatible('1.0.0', '').compatible).toBe(false);
});

// ── result shape ──────────────────────────────────────────────────────────────

test('result always includes daemonVersion and clientVersion', () => {
  const r = isVersionCompatible('1.2.3', '1.4.5');
  expect(r.daemonVersion).toBe('1.2.3');
  expect(r.clientVersion).toBe('1.4.5');
});

test('compatible result has no reason field', () => {
  const r = isVersionCompatible('1.0.0', '1.0.0');
  expect(r.compatible).toBe(true);
});
