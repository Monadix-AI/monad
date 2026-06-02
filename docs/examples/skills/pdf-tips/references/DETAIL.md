# PDF extraction — detailed reference

This file is loaded **on demand** (L3), only when a task needs the depth — it costs no
context until the model requests it through the `skill` tool's `file` argument.

## Text

- Extract per page; preserve reading order. Watch for multi-column layouts (text may
  interleave) — segment by column before concatenating.

## Tables

- Prefer a layout-aware extractor (ruling lines, cell bounding boxes) over naive text
  splitting. Validate row/column counts against the visible grid.
- For borderless tables, cluster by x-position to recover columns.

## Forms

- Read the AcroForm field tree for field names/values rather than scraping rendered text.

## Scanned / image-only PDFs

- No text layer → run OCR first, then treat as text. Quality depends on DPI; upscale low-res
  scans before OCR. Expect to post-correct common OCR confusions (l/1, O/0, rn/m).
