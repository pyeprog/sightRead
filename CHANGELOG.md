# Change Log

All notable changes to the SightRead extension are documented in this file.

## [0.0.1] — 2026-07-08

Initial release.

- **Skeleton fold** — collapse everything inside the current function recursively, leaving each block as a one-line summary; unfold restores.
- **Highlighter markers** — mark selected lines in five colors with optional notes; markers touched by an edit are deleted automatically; bulk-remove for selection / function / file / workspace; Markers sidebar view.
- **Variable tint** — outline every occurrence of the symbol under the cursor within the enclosing function (reads vs writes styled differently).
- **Spotlight** — three focus levels (function / segment / segment+variable) dimming everything outside the focus, with graceful degradation.
- **Automatic segmentation** — heuristic recursive segment tree per function with structural names; powers the spotlight, `Go to Segment…`, and the Segments sidebar view.
