# Message URL Favicon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render each HTTP or HTTPS URL in regular chat sessions, chat experiences, and project-session messages with the target origin's `/favicon.ico` immediately before the link text.

**Architecture:** Add one message-scoped link renderer to `@monad/ui`, plus a pure tokenizer used by `MentionText` for human plain-text messages. Pass the shared Markdown anchor component explicitly into the two message Markdown pipelines, preserving the chat-room mention-link override.

**Tech Stack:** React, TypeScript, Streamdown component overrides, Bun test, Biome.

## Global Constraints

- Work directly on `main`, as requested by the user.
- Preserve unrelated staged and unstaged changes; stage only files named by the current task.
- Use only the browser to request `${origin}/favicon.ico`; do not add a daemon proxy, third-party favicon service, metadata fetch, or cache.
- Only `http:` and `https:` URLs may produce favicon image requests.
- Failed favicon images disappear without a placeholder, toast, or retained gap.
- Keep non-message Markdown surfaces unchanged.
- Follow red-green-refactor: observe the relevant test fail before changing production code.
- Use Bun commands only.

---

### Task 1: Shared favicon link and human-message URL tokenization

**Files:**
- Create: `packages/ui/src/components/FaviconLink.tsx`
- Modify: `packages/ui/src/components/MentionText.tsx`
- Modify: `packages/ui/src/index.ts`
- Create: `packages/ui/test/unit/favicon-link.test.tsx`
- Modify: `apps/web/test/unit/mention-text.test.ts`

**Interfaces:**
- Produces: `faviconHref(href: string | undefined): string | undefined`
- Produces: `hideFailedFavicon(target: Pick<HTMLImageElement, 'hidden'>): void`
- Produces: `FaviconLink(props: ComponentProps<'a'>): ReactElement`
- Produces: `faviconMarkdownComponents: Components`
- Produces: `messageTextSegments(text: string): MessageTextSegment[]`
- Preserves: `mentionSegments`, `parseMentionTokens`, `mentionToken`, and `MentionCapsule`

- [ ] **Step 1: Write failing tests for favicon URL derivation and rendering**

Create `packages/ui/test/unit/favicon-link.test.tsx`:

```tsx
import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { FaviconLink, faviconHref, hideFailedFavicon } from '../../src/components/FaviconLink.tsx';

test('faviconHref derives the target origin favicon only for HTTP URLs', () => {
  expect([
    faviconHref('https://docs.example.com/path?q=1'),
    faviconHref('http://example.test:8080/a'),
    faviconHref('mailto:team@example.com'),
    faviconHref('javascript:alert(1)'),
    faviconHref('not a url')
  ]).toEqual([
    'https://docs.example.com/favicon.ico',
    'http://example.test:8080/favicon.ico',
    undefined,
    undefined,
    undefined
  ]);
});

test('FaviconLink renders a decorative favicon before the original link label', () => {
  const markup = renderToStaticMarkup(
    createElement(FaviconLink, { href: 'https://example.com/docs' }, 'Example docs')
  );
  expect(markup).toContain('src="https://example.com/favicon.ico"');
  expect(markup).toContain('aria-hidden="true"');
  expect(markup).toContain('href="https://example.com/docs"');
  expect(markup).toContain('rel="noopener noreferrer"');
  expect(markup.indexOf('<img')).toBeLessThan(markup.indexOf('Example docs'));
});

test('failed favicons are removed from layout', () => {
  const target = { hidden: false };
  hideFailedFavicon(target);
  expect(target).toEqual({ hidden: true });
});
```

- [ ] **Step 2: Run the new UI test and verify RED**

Run:

```bash
bun scripts/bun-test.ts packages/ui/test/unit/favicon-link.test.tsx --only-failures
```

Expected: FAIL because `FaviconLink.tsx` does not exist.

- [ ] **Step 3: Implement the shared favicon link**

Create `packages/ui/src/components/FaviconLink.tsx` with this behavior:

```tsx
import type { ComponentProps } from 'react';
import type { Components } from 'streamdown';

import { cn } from '../lib/utils.ts';

export function faviconHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return new URL('/favicon.ico', url.origin).href;
  } catch {
    return undefined;
  }
}

export function hideFailedFavicon(target: Pick<HTMLImageElement, 'hidden'>): void {
  target.hidden = true;
}

export function FaviconLink({ children, className, href, ...props }: ComponentProps<'a'>) {
  const favicon = faviconHref(href);
  return (
    <a
      {...props}
      className={cn(className)}
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      {favicon ? (
        <img
          alt=""
          aria-hidden="true"
          className="mr-1 inline size-3.5 rounded-[2px] align-[-2px]"
          onError={(event) => hideFailedFavicon(event.currentTarget)}
          src={favicon}
        />
      ) : null}
      {children}
    </a>
  );
}

export const faviconMarkdownComponents = { a: FaviconLink } satisfies Components;
```

Export `FaviconLink`, `faviconHref`, `hideFailedFavicon`, and `faviconMarkdownComponents` from `packages/ui/src/index.ts` following the file's existing type/value export layout.

- [ ] **Step 4: Run the favicon test and verify GREEN**

Run the same targeted command. Expected: 3 pass, 0 fail.

- [ ] **Step 5: Write failing tests for URL and mention segmentation**

Extend `apps/web/test/unit/mention-text.test.ts`:

```ts
import { messageTextSegments } from '@monad/ui/components/MentionText';

test('messageTextSegments preserves mentions and links bare web URLs without sentence punctuation', () => {
  expect(
    messageTextSegments(
      'Ask @[name="codex" id="external-agent:codex"] to open https://docs.example.com/a?q=1, then reply.'
    )
  ).toEqual([
    { kind: 'text', text: 'Ask ' },
    { kind: 'mention', name: 'codex', id: 'external-agent:codex' },
    { kind: 'text', text: ' to open ' },
    { kind: 'url', href: 'https://docs.example.com/a?q=1', text: 'https://docs.example.com/a?q=1' },
    { kind: 'text', text: ', then reply.' }
  ]);
});

test('messageTextSegments leaves non-web schemes and email text unchanged', () => {
  expect(messageTextSegments('email z@example.com or use mailto:z@example.com')).toEqual([
    { kind: 'text', text: 'email z@example.com or use mailto:z@example.com' }
  ]);
});
```

- [ ] **Step 6: Run the mention test and verify RED**

Run:

```bash
bun scripts/bun-test.ts apps/web/test/unit/mention-text.test.ts --only-failures
```

Expected: FAIL because `messageTextSegments` is not exported.

- [ ] **Step 7: Implement ordered mention and URL segmentation**

In `MentionText.tsx`, add a `MessageTextSegment` union and a pure `messageTextSegments` function. Build URL tokens only inside the text gaps between strict mention tokens, using an HTTP(S)-only global regex and moving terminal `. , ! ? ; :` characters back into a text segment. Merge adjacent text segments so exact source order is retained.

Use this tokenizer shape:

```tsx
export type MessageTextSegment =
  | MentionSegment
  | { kind: 'url'; href: string; text: string };

const WEB_URL_RE = /https?:\/\/[^\s<]+/gi;
const TRAILING_URL_PUNCTUATION_RE = /[.,!?;:]+$/;

function pushTextSegment(segments: MessageTextSegment[], text: string): void {
  if (!text) return;
  const previous = segments.at(-1);
  if (previous?.kind === 'text') previous.text += text;
  else segments.push({ kind: 'text', text });
}

function linkifiedTextSegments(text: string): MessageTextSegment[] {
  const segments: MessageTextSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(WEB_URL_RE)) {
    const start = match.index ?? 0;
    const matched = match[0];
    const punctuation = TRAILING_URL_PUNCTUATION_RE.exec(matched)?.[0] ?? '';
    const href = punctuation ? matched.slice(0, -punctuation.length) : matched;
    if (start > cursor) pushTextSegment(segments, text.slice(cursor, start));
    if (faviconHref(href)) segments.push({ kind: 'url', href, text: href });
    else pushTextSegment(segments, href);
    pushTextSegment(segments, punctuation);
    cursor = start + matched.length;
  }
  if (cursor < text.length) pushTextSegment(segments, text.slice(cursor));
  return segments;
}

export function messageTextSegments(text: string): MessageTextSegment[] {
  return mentionSegments(text).flatMap((segment) =>
    segment.kind === 'mention' ? [segment] : linkifiedTextSegments(segment.text)
  );
}
```

The final output must match the exact expected arrays in Step 5.

Update `MentionText` to map `messageTextSegments(text)`:

```tsx
return segment.kind === 'mention' ? (
  <MentionCapsule id={segment.id} key={key} name={segment.name} />
) : segment.kind === 'url' ? (
  <FaviconLink href={segment.href} key={key}>{segment.text}</FaviconLink>
) : (
  <span className="[overflow-wrap:anywhere]" key={key}>{segment.text}</span>
);
```

Do not change the output contract of `mentionSegments`.

- [ ] **Step 8: Run Task 1 tests and verify GREEN**

Run:

```bash
bun scripts/bun-test.ts packages/ui/test/unit/favicon-link.test.tsx apps/web/test/unit/mention-text.test.ts --only-failures
```

Expected: all cases pass with no warnings.

- [ ] **Step 9: Commit Task 1**

Stage only the five Task 1 files and commit:

```bash
git commit -m "feat(ui): add favicon links for message text"
```

---

### Task 2: Regular chat-session Markdown integration

**Files:**
- Modify: `apps/web/src/features/session/MessageBody.tsx`
- Modify: `apps/web/src/features/session/ChatMessage.tsx`
- Modify: `apps/web/test/unit/chat-message.test.ts`

**Interfaces:**
- Consumes: `faviconMarkdownComponents` from `@monad/ui`
- Produces: regular session assistant, directive Markdown, card body, and fallback Markdown links with favicons

- [ ] **Step 1: Write failing regular-session rendering tests**

Extend `apps/web/test/unit/chat-message.test.ts` with one user and one assistant assertion:

```tsx
test('regular session messages render favicons before human and assistant URLs', () => {
  const user = renderToStaticMarkup(createElement(MessageBody, {
    isUser: true,
    text: 'Open https://example.com/docs.'
  }));
  const assistant = renderToStaticMarkup(createElement(Message, {
    assistantLabel: 'Assistant',
    msg: { id: 'msg_link', role: 'assistant', text: '[Example](https://example.com/docs)' }
  }));

  expect(user).toContain('src="https://example.com/favicon.ico"');
  expect(user).toContain('href="https://example.com/docs"');
  expect(assistant).toContain('src="https://example.com/favicon.ico"');
  expect(assistant).toContain('>Example</a>');
});
```

If Streamdown adds wrapper markup between the image and label, assert the image source, anchor destination, and visible label independently rather than matching a brittle full HTML substring.

- [ ] **Step 2: Run the regular-session test and verify RED**

Run:

```bash
bun scripts/bun-test.ts apps/web/test/unit/chat-message.test.ts --only-failures
```

Expected: the human assertion passes after Task 1, while the assistant favicon assertion fails.

- [ ] **Step 3: Pass the shared anchor renderer into regular-session Markdown**

In `MessageBody.tsx`, import `faviconMarkdownComponents` and pass it to both `<Markdown>` uses, including `CardRenderer` and the fallback renderer.

In `ChatMessage.tsx`, import `faviconMarkdownComponents` and render:

```tsx
<MessageResponse components={faviconMarkdownComponents}>{msg.text}</MessageResponse>
```

Keep directive and rich-message selection unchanged.

- [ ] **Step 4: Run the regular-session test and verify GREEN**

Run the same targeted command. Expected: all cases pass.

- [ ] **Step 5: Commit Task 2**

Stage only the three Task 2 files and commit:

```bash
git commit -m "feat(chat): show favicons in session links"
```

---

### Task 3: Chat-experience and project-session Markdown integration

**Files:**
- Modify: `packages/atoms/src/workspace-experiences/chat-room/components/message-row.tsx`
- Modify: `packages/atoms/test/unit/workspace-chat-transcript-markdown.test.ts`

**Interfaces:**
- Consumes: `FaviconLink` from `@monad/ui`
- Preserves: `#monad-mention-*` links render as `MentionCapsule`
- Produces: all non-mention workspace message anchors render through `FaviconLink`

- [ ] **Step 1: Write a failing workspace Markdown component test**

Export the existing message component map as `messageMarkdownComponents` for direct testing. Add a test that invokes its `a` renderer for both branches and renders the returned elements:

```tsx
test('workspace Markdown keeps mention capsules and adds favicons to web links', () => {
  const mention = renderWorkspaceMarkdownAnchor('#monad-mention-external-agent%3Acodex', '@codex');
  const web = renderWorkspaceMarkdownAnchor('https://example.com/docs', 'Example');

  expect(mention).toContain('data-composer-chip="mention"');
  expect(mention).not.toContain('favicon.ico');
  expect(web).toContain('src="https://example.com/favicon.ico"');
  expect(web).toContain('href="https://example.com/docs"');
});
```

The local `renderWorkspaceMarkdownAnchor` test helper should call the exported anchor renderer with `{ href, children }` and use `renderToStaticMarkup`; it must exercise the actual renderer, not duplicate its branching logic.

- [ ] **Step 2: Run the workspace Markdown test and verify RED**

Run:

```bash
bun scripts/bun-test.ts packages/atoms/test/unit/workspace-chat-transcript-markdown.test.ts --only-failures
```

Expected: mention behavior passes; the web anchor has no favicon.

- [ ] **Step 3: Delegate non-mention anchors to `FaviconLink`**

Rename `MENTION_MARKDOWN_COMPONENTS` to `messageMarkdownComponents`, export it for the focused test, and replace its non-mention branch with:

```tsx
return <FaviconLink href={href}>{children}</FaviconLink>;
```

Continue passing this component map into `MarkdownWithMentions`. No project-specific branch is needed because chat experiences and project sessions share `MessageRow`.

- [ ] **Step 4: Run workspace and shared tests and verify GREEN**

Run:

```bash
bun scripts/bun-test.ts packages/atoms/test/unit/workspace-chat-transcript-markdown.test.ts packages/ui/test/unit/favicon-link.test.tsx apps/web/test/unit/mention-text.test.ts --only-failures
```

Expected: all cases pass.

- [ ] **Step 5: Commit Task 3**

Stage only the two Task 3 files and commit:

```bash
git commit -m "feat(workplace): show favicons in message links"
```

---

### Task 4: Final verification

**Files:**
- Review all files changed in Tasks 1-3
- Do not modify unrelated worktree files

**Interfaces:**
- Verifies the complete feature and repository quality gates

- [ ] **Step 1: Run focused regression tests**

```bash
bun scripts/bun-test.ts packages/ui/test/unit/favicon-link.test.tsx apps/web/test/unit/mention-text.test.ts apps/web/test/unit/chat-message.test.ts packages/atoms/test/unit/workspace-chat-transcript-markdown.test.ts --only-failures
```

Expected: 0 failures.

- [ ] **Step 2: Run formatting and static checks**

```bash
bun run lint
bun run typecheck
```

Expected: Biome succeeds and Turbo reports every typecheck task successful. If an unrelated concurrently edited file fails, record the exact path and failure without changing that file.

- [ ] **Step 3: Run the full test suite**

```bash
bun run test
```

Expected: all Turbo test tasks succeed.

- [ ] **Step 4: Audit the final diff**

Confirm:

- only message surfaces receive favicon components;
- no third-party favicon endpoint, daemon route, metadata fetch, or cache was added;
- every image source is the parsed HTTP(S) origin plus `/favicon.ico`;
- mentions, user commands, skills, and surrounding punctuation retain existing behavior;
- unrelated staged and unstaged files remain untouched.

- [ ] **Step 5: Commit any verification-only corrections**

If Tasks 1-3 required a scoped correction, stage only the affected feature files and commit:

```bash
git commit -m "fix(chat): finalize message favicon rendering"
```

If no correction was needed, do not create an empty commit.
