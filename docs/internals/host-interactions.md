# Host interactions

Host interactions let built-in features and atom packs request bounded user input without shipping UI code. The requester declares semantic content; Monad owns presentation, attribution, validation, secrets, and completion across Web, TUI, CLI, and ACP.

## Requesting input from an atom pack

Use the `requestInteraction` function on `AtomPackContext` and await the result:

```ts
const result = await ctx.requestInteraction({
  type: 'form',
  title: 'Connect the provider',
  description: 'Enter the credentials supplied by your provider.',
  fields: [
    { id: 'region', type: 'select', label: 'Region', options: regions, required: true },
    { id: 'apiKey', type: 'secret', label: 'API key', required: true }
  ],
  submitLabel: 'Connect'
});

if (result.status === 'submitted') {
  await connect(result.values);
}
```

Supported request types are `confirm`, `select`, and `form`. Form fields may be `string`, `secret`, `number`, `boolean`, or `select`. Declarative constraints include required fields, number ranges, string patterns, defaults, descriptions, and select options.

Do not pass HTML, scripts, components, callback functions, executable validators, or layout instructions. They are intentionally outside the protocol.

## Lifecycle

The daemon assigns an ID and trusted source attribution, then publishes a redacted pending request. A presenter must advertise compatible capabilities and claim the request with a short lease before submitting or cancelling it. Completion happens exactly once.

Foreground requests prefer the client that initiated the action. Background requests enter the shared queue and do not steal focus. A claim released by a disconnect or expired lease can be acquired by another compatible presenter; secret drafts are never retained.

Cancellation reports one of `close`, `escape`, `timeout`, `disconnect`, or `unavailable`. Callers must treat every cancellation as a normal terminal result and must not assume a Web client exists.

## Client behavior

- Web uses a host-owned dialog and shows the trusted source above contributed labels.
- TUI uses a host-owned modal with keyboard navigation and masked secret input.
- Interactive CLI prompts field by field and disables terminal echo for secrets.
- Non-interactive CLI emits `interaction_required` with the interaction ID. A user can resume with `monad interaction answer <id>`.
- ACP bridges compatible schemas to elicitation and leaves unsupported requests pending or returns an explicit unavailable result.

Presenters must render the full schema or refuse the claim; partial rendering is not allowed.

## Security rules

Secret values never appear in pending-list responses, events, logs, transcripts, shell history, structured non-interactive output, or retry state. A presenter without safe secret input cannot claim a secret-bearing request. Only the requesting atom receives submitted values.

The daemon enforces schema and text-size bounds, request timeouts, per-source pending limits, claim leases, and non-spoofable source attribution. Third-party content cannot control host chrome or imitate a built-in source.
