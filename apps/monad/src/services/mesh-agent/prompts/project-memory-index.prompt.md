# Project memory index

Durable Workplace Project context shared across managed agents — decisions, conventions,
status, and external references that a later agent cannot recover from `project read`
or the code itself. Not a transcript: transient chatter and in-progress task state do not
belong here.

- Each line below points to one file under `memories/`: `- [title](memories/file.md) — one-line hook`.
- A detail file starts with frontmatter (`name`, `description`, `metadata.type`); `type` is one of
  `decision`, `convention`, `status`, `reference`.
- Before writing, check whether an existing file already covers the topic and update it instead of
  adding a duplicate.
- Acquire `MEMORY.md.lock` before editing this file or any file under `memories/`; release it after
  the write, even if the write fails.
