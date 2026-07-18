# Chat Local File Preview Design

## Goal

Improve the built-in Chat Experience in two related ways:

1. Render Markdown links explicitly marked with the title `monad:file` as local-file references rather than ordinary web URLs. Clicking one opens a right-side file preview with line numbers and syntax highlighting.
2. Render message attachments as a two-row card: file identity on the first row and metadata plus actions on the second row.
3. Keep inline Markdown links vertically aligned with the surrounding message text.

This work is limited to the built-in `chat-room` workspace experience. It does not change session-page transcript rendering outside that experience.

## Existing Contract

Native-agent output already uses the following Markdown contract:

```md
[report.md](/absolute/path/report.md "monad:file")
```

The daemon parses the `monad:file` title, resolves the path within the agent's allowed workspace roots, and registers the resolved file as a structured attachment on the same message. The visible Markdown text remains unchanged.

The client must preserve that security boundary. It must not add an endpoint that reads an arbitrary path supplied by rendered Markdown, and it must not infer local files from unmarked absolute or relative URLs.

## Local File Link Rendering

The Chat Experience Markdown renderer will treat an anchor as a local-file reference only when its Markdown title is exactly `monad:file`.

For each marked link, the renderer will normalize the link destination for comparison and match it against the structured attachments already present on that message. Fragment suffixes used for line references, such as `#L12`, are excluded from path matching and retained as preview navigation metadata when valid. `file:` URLs and percent-encoded paths are normalized to their decoded local path form for comparison.

When a structured attachment matches:

- Render a file-type icon inferred from the attachment name and MIME type.
- Render the original link label.
- Replace external navigation with an in-app button/link interaction.
- Open the matched attachment in the right-side file preview.

When a marked link does not match a structured attachment:

- Still render it with a generic file icon so it is not presented as a web URL.
- Do not navigate to the destination or attempt an arbitrary-path read.
- Expose a disabled state and accessible explanation that the file is unavailable.

Ordinary HTTP and HTTPS links continue to use the existing favicon treatment and open externally. Mention capsules remain unchanged.

## Inline Link Alignment

Both ordinary web links and local-file links remain inline affordances inside the Markdown line box. Their anchor container, icon wrapper, icon, and label will share an explicit line-height and baseline alignment contract so the icon does not raise or lower the linked label relative to adjacent plain text.

The fix belongs in the shared link primitives rather than as message-specific positional nudges. It must preserve multi-line wrapping, selection, focus styling, and the current compact icon size.

## Shared File Icon

Move the existing extension/MIME-to-icon selection into `@monad/ui` so both the web app and the built-in Chat Experience use the same file icon vocabulary. The existing web import becomes a re-export or imports the shared component, avoiding divergent icon maps.

The icon remains decorative when the adjacent filename supplies the accessible name.

## Preview State and Right Rail

The Chat Experience store will gain session-scoped file-preview state alongside the existing observation-rail state. A preview entry contains the structured attachment reference and an optional requested line number derived from the link fragment.

Opening a file preview replaces the current detailed rail content for that project session. The persistent agent list and rail sizing behavior remain intact. Closing or going back clears only the file preview and returns to the normal agent rail. Opening an agent observation replaces the file preview, preserving a single-detail-panel model rather than stacking drawers.

Both local-file links and attachment Preview actions call the same `openFilePreview` action. The attachment API remains the sole content source: `/v1/attachments/:id`.

## File Preview Panel

The new panel occupies the existing resizable right rail and includes:

- Header with the file icon, filename, optional path tooltip, and close/back control.
- Scrollable content with one visual row per source line.
- A stable line-number gutter.
- Shiki syntax highlighting inferred from the filename extension, with plain-text fallback.
- Initial scrolling/highlighting for a valid `#L<number>` fragment.
- Loading, unavailable, unsupported, and truncated states.
- Download action using the existing attachment download endpoint.

Only MIME types already accepted by `isPreviewableAttachmentMime` receive a text/code preview. Other attachments retain Download and show an unsupported-preview state if reached defensively.

## Attachment Card Layout

`AttachmentCard` becomes a fixed two-row layout:

- First row: file-type icon and filename.
- Second row: formatted size, Preview action when supported, and Download action.

The filename may wrap or truncate without moving metadata and actions onto the first row. The current inline expanded `<pre>` is removed. Preview becomes a controlled callback that opens the shared right-side panel; Download behavior remains unchanged.

## Error Handling

- Attachment content load failures render inside the preview panel without changing the transcript.
- Closing a loading preview makes late responses harmless because query state is keyed by attachment ID and the closed preview is no longer rendered.
- A marked link with no matching attachment cannot perform navigation or trigger a read.
- Invalid or missing line fragments open the file at its beginning.
- Truncated server responses display the returned content and an explicit truncation notice rather than appending ambiguous punctuation to the source text.

## Testing

Implementation follows test-driven development with focused regression coverage:

1. Markdown anchor tests prove that `monad:file` renders a file affordance, ordinary web links keep favicons, mentions remain capsules, unmatched file references cannot navigate, and link primitives expose the shared baseline-alignment contract.
2. Path-matching tests cover absolute paths, `file:` URLs, percent encoding, and `#L<number>` fragments.
3. Attachment card rendering tests prove the two-row structure, file icon, metadata, and action placement, and prove inline preview content is gone.
4. Store tests prove file-preview state is session-scoped and mutually exclusive with agent observation detail.
5. Preview panel tests prove loading/error/truncated states, line numbers, language selection, and requested-line highlighting.
6. Existing package unit tests and typechecks run after focused tests.
7. The supplied local workspace session is manually verified for both a marked local-file link and a message attachment. If the self-signed HTTPS certificate blocks automated browser access, verification will report that limitation explicitly rather than claim live UI coverage.

## Non-goals

- Inferring local files from unmarked Markdown links.
- Reading arbitrary filesystem paths from the browser.
- Editing files in the preview.
- Image, PDF, audio, video, or archive preview.
- Changing attachment registration, storage, or daemon authorization.
- Changing non-Chat-Experience session transcripts.
