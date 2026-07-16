# Examples

Copyable starting points for Monad's two extension surfaces: skills and atom packs.

## Skills

Example skills in [skills/](skills/) — copy a directory into `~/.monad/skills/` to try it.
The format and frontmatter reference is in [usage/skills.md](../usage/skills.md).

| Skill | Demonstrates |
|---|---|
| [summarize-changes/](skills/summarize-changes/) | The minimal model-invocable skill: frontmatter + instructions. |
| [commit/](skills/commit/) | User-only invocation (`disable-model-invocation`) with `$ARGUMENTS` and `allowed-tools`. |
| [pdf-tips/](skills/pdf-tips/) | Bundling an L3 reference file the model loads on demand. |
| [deep-research/](skills/deep-research/) | Forked execution (`context: fork`) at a capability `tier`. |

## Atom packs

Runnable atom pack examples live with the authoring SDK in
[`packages/sdk-atom/examples/`](../../packages/sdk-atom/examples/) (not duplicated here):

| Example | Demonstrates |
|---|---|
| [`echo/`](../../packages/sdk-atom/examples/echo/) | The minimal pack: one `channel` atom (a loopback test channel), a `atom-pack.json` manifest, and the `defineAtomPack` envelope. |
| [`multi/`](../../packages/sdk-atom/examples/multi/) | One pack bundling four atom kinds — channel, slash command, model provider, and message type — with manifest-gated declaration. |

To ship a pack, bundle the entry to a single file and drop
`<name>/{atom-pack.json, dist/atom-pack.js}` into `~/.monad/atoms/`:

```sh
bun build ./atom-pack.ts --target=bun --outfile dist/atom-pack.js
```

The authoring contract is `@monad/sdk-atom`; the pack system is documented in
[internals/atoms.md](../internals/atoms.md).
