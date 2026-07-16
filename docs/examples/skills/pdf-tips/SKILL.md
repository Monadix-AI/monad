---
name: pdf-tips
description: Guidance for extracting text and tables from PDF files. Use when the user works with PDFs or mentions PDF extraction.
metadata:
  author: Monad-examples
  version: "1.0"
---

# Working with PDFs

For most text extraction, read the page text directly. For tables, forms, or scanned
documents, the approach differs — load the detailed reference only when the task needs it:

- Tables / forms / OCR → load `references/DETAIL.md` via the `skill` tool:
  `{"tool":"skill","input":{"name":"pdf-tips","file":"references/DETAIL.md"}}`

Start simple; only pull the reference when the basic path isn't enough. This keeps the
detailed material out of context until it's actually required (L3 progressive disclosure).
