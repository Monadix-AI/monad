import { expect, test } from 'bun:test';

import { ircPrivmsgToInbound, parseIrcLine } from '../../src/channels/irc.ts';

test('IRC1: parseIrcLine splits prefix, command, params + trailing', () => {
  const l = parseIrcLine(':alice!u@h PRIVMSG #chan :hello world');
  expect(l.prefix).toBe('alice!u@h');
  expect(l.command).toBe('PRIVMSG');
  expect(l.params).toEqual(['#chan', 'hello world']);
});

test('IRC2: channel target → group keyed by channel; PM → dm keyed by sender', () => {
  const grp = ircPrivmsgToInbound(parseIrcLine(':bob!u@h PRIVMSG #room :hi'), 'monad', 1);
  expect(grp).toMatchObject({ chatId: '#room', userId: 'bob', chatType: 'group' });
  const dm = ircPrivmsgToInbound(parseIrcLine(':bob!u@h PRIVMSG monad :hi'), 'monad', 2);
  expect(dm).toMatchObject({ chatId: 'bob', chatType: 'dm' });
});

test('IRC3: mentionedSelf when the bot nick appears; command parse', () => {
  const m = ircPrivmsgToInbound(parseIrcLine(':bob!u@h PRIVMSG #r :monad: hello'), 'monad', 1);
  expect(m?.mentionedSelf).toBe(true);
  const c = ircPrivmsgToInbound(parseIrcLine(':bob!u@h PRIVMSG #r :/New x'), 'monad', 1);
  expect(c).toMatchObject({ kind: 'command', command: 'new', commandArgs: ['x'] });
});

test('IRC4: isSelf guards the bot’s own nick; non-PRIVMSG → null', () => {
  expect(ircPrivmsgToInbound(parseIrcLine(':monad!u@h PRIVMSG #r :hi'), 'monad', 1)?.isSelf).toBe(true);
  expect(ircPrivmsgToInbound(parseIrcLine(':x!u@h JOIN #r'), 'monad', 1)).toBe(null);
});

import { sanitizeIrcTarget, sanitizeIrcText } from '../../src/channels/irc.ts';

test('IRC5: outbound sanitizer strips CR/LF + control chars (command-injection guard)', () => {
  // A hostile agent reply trying to smuggle a raw IRC command must be neutralized.
  expect(sanitizeIrcText('hi\r\nJOIN #evil')).toBe('hi  JOIN #evil'); // CRLF → spaces, no new line
  expect(sanitizeIrcText('a\x01b\x1fc')).toBe('a b c');
  expect(sanitizeIrcText('plain text')).toBe('plain text');
});

test('IRC6: target validation rejects whitespace/CRLF/colon-led targets', () => {
  expect(sanitizeIrcTarget('#room')).toBe('#room');
  expect(sanitizeIrcTarget('nick')).toBe('nick');
  expect(() => sanitizeIrcTarget('#room :x')).toThrow();
  expect(() => sanitizeIrcTarget('a\r\nQUIT')).toThrow();
  expect(() => sanitizeIrcTarget(':evil')).toThrow();
});
