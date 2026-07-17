# Message URL Favicon Design

## Goal

Render a website favicon immediately before every HTTP or HTTPS URL shown in message content across:

- regular chat sessions;
- chat workspace experiences;
- project-session messages.

This applies to bare URLs and Markdown links with custom labels. Human and agent messages should behave consistently.

## Scope

The change is limited to message content. It does not alter Markdown rendered in settings, documentation, cards, or other non-message surfaces. It does not add link previews, page metadata fetching, daemon-side proxying, or favicon caching.

## Shared UI Contract

`@monad/ui` will own a reusable favicon link renderer. Given an HTTP or HTTPS `href`, it will:

1. parse the URL;
2. derive the favicon source from the URL origin with the `/favicon.ico` path;
3. render a decorative favicon before the existing link content;
4. preserve the original link text and destination;
5. open external links in a new tab with `noopener noreferrer`;
6. hide the image after a load error so no empty icon space remains.

Unsupported or invalid schemes do not trigger a favicon request. The favicon is decorative and excluded from the accessibility tree. The link text remains the accessible name.

Rendering the icon causes the browser to request the target origin's `/favicon.ico` as soon as the message is displayed. Monad does not proxy this request through the daemon or a third-party favicon service.

## Rendering Integration

### Markdown messages

The shared favicon link renderer will be exposed as a message-specific Markdown `a` component. It will be passed explicitly to:

- the regular session assistant `MessageResponse`;
- Markdown fallbacks in regular session `MessageBody`;
- the chat-room `MarkdownWithMentions` renderer used by chat experiences and project sessions.

The chat-room renderer will retain its special mention-link handling. Only non-mention HTTP or HTTPS links will use the favicon renderer.

Streamdown remains responsible for parsing explicit Markdown links and autolinking bare URLs. The change replaces only the final anchor rendering.

### Human plain-text messages

`MentionText` will recognize HTTP and HTTPS URL spans alongside mention spans. Text outside those spans remains unchanged. Mention capsules keep their current behavior, while URL spans render through the shared favicon link renderer.

Tokenization must preserve source order and exact non-URL text. Trailing sentence punctuation that is not part of the URL must stay outside the link.

## Visual Behavior

The favicon is an inline 14-pixel image aligned with the text baseline and separated from the link label by a small gap. A failed image is removed from layout. The existing link color, underline, wrapping, and hover behavior remain unchanged.

No placeholder, generated initials, or generic globe icon is shown on failure.

## Security and Failure Handling

- Only `http:` and `https:` URLs may produce favicon requests.
- The favicon URL is constructed with the platform `URL` parser, never string concatenation.
- Link destinations retain the existing safe external-link attributes.
- Image failures are local presentation failures and do not produce an error card or toast.
- No page HTML is fetched or parsed.
- No daemon request, server-side request, or privileged-network access is introduced.

## Testing

Tests will prove:

- HTTP and HTTPS links derive the expected origin `/favicon.ico` URL;
- invalid and non-web schemes do not render favicons;
- a favicon image hides after its error handler runs;
- plain-text bare URLs are linked without losing surrounding text or trailing punctuation;
- mention capsules and URLs preserve their original order;
- Markdown bare URLs and named links render with favicons;
- regular chat-session assistant and rich-message Markdown paths pass the message link component;
- chat-experience and project-session Markdown retains mention handling while adding favicons.

Implementation follows red-green-refactor: each behavior receives a failing test before production code changes.
