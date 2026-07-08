# Change Log

All notable changes to the SightRead extension are documented in this file.

## [Unreleased]

- **Fix: spotlight over nested local functions** — with the cursor on a nested function's definition header, the spotlight used to scope to the nested function itself, heavily dimming its call sites in the outer function at every level. The definition header line now reads as a statement of the outer function, so a local definition and its call sites spotlight each other in both directions (cursor in the nested body still focuses the nested function).
- **Seg+Var: related islands outside the current function** — occurrences of the symbol under the cursor that live outside the innermost function (a sibling local function's definition, a closure variable's declaration) now light their segment of the outermost enclosing function as fully-lit islands, while the anchor function keeps its normal four-tier focus. Variable tint occurrences are accordingly clipped to the outermost enclosing function instead of the innermost one.

## [1.0.0] — 2026-07-08

Initial release.

- **Skeleton fold** — collapse everything inside the current function recursively, leaving each block as a one-line summary; unfold restores.
- **Highlighter markers** — mark selected lines in five colors with optional notes; markers touched by an edit are deleted automatically; bulk-remove for selection / function / file / workspace; Markers sidebar view.
- **Variable tint** — outline every occurrence of the symbol under the cursor within the enclosing function (reads vs writes styled differently).
- **Spotlight** — three focus levels (function / segment / segment+variable) dimming everything outside the focus, with graceful degradation; cycle Off → Seg+Var → Seg → Fn from the status-bar eye button, the Segments view, or the command palette.
- **Automatic segmentation** — heuristic recursive segment tree per function with structural names; powers the spotlight, `Go to Segment…`, and the Segments sidebar view. Each node also carries a condensed header expression (the `if` condition, loop header, return value) rendered as dimmed detail text in the Segments view and the `Go to Segment…` picker.
