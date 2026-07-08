# SightRead

A reading lens for code — highlight, dim, fold and outline function segments to help you understand code **in place**, right inside the editor.

> Status: early experiment (0.x). Sibling project of [Navigation History](https://github.com/pyeprog/navigation-history).

## Why

Reading a heavyweight (often vibe-coded) project is hard: you don't know where to start, the volume buries the skeleton, and LLM explanations live in a sidebar — detached from the code they explain. SightRead explores the opposite direction: keep the understanding **anchored** to real code positions, rendered with native editor primitives (decorations, folding, document symbols), all local and instant — no LLM required.

See [doc/discussion.md](doc/discussion.md) for the founding discussion, [doc/features.md](doc/features.md) for the feature triage, and [doc/design.md](doc/design.md) for the converged design (all in Chinese).

## Features

Five orthogonal lenses, each owning one visual channel (see design.md §二):

- **Skeleton fold** — `SightRead: Fold Skeleton` collapses everything inside the current function recursively (the function itself stays open), leaving each block as a one-line summary that expands level by level. `Unfold Skeleton` restores.
- **Highlighter (markers)** — mark selected lines yellow / red / green (blue & purple via the picker), with an optional note rendered at the end of the first marked line. Persistent but deliberately short-lived: **any edit touching marked lines deletes the marker**; bulk-remove commands cover selection / function / file / workspace.
- **Variable tint** — the transient twin of the highlighter: put the cursor on a symbol and every occurrence within the enclosing function is outlined (reads blue, writes orange); move away and it fades.
- **Spotlight** — click the 👁 button on the Segments view (level shows as a number badge on the activity-bar icon) or run `Cycle Spotlight Level`:
  1. **Fn** — dim everything outside the current function;
  2. **Seg** — four-tier dimming over the segment tree: outside the function (dimmest), non-related code, siblings of the cursor's segment, and the segment itself + its descendants (full);
  3. **Seg+Var** — segments touched by the symbol under the cursor stay lit too.
  Degrades gracefully: no symbols / no segments → falls back a level.
- **Auto segmentation** — functions are split into a **recursive segment tree** by blank lines + nesting, fully heuristic, no LLM. Nodes get structural names (`if ... elif{2} ... else ...`, `for ...`, `try ... except ...`, `def foo`, `a=.. b=..`, `fetch(...)`) — never comment text. Consumed by the spotlight, `Go to Segment…`, and the Segments sidebar view (kind-colored icons).
- **Sidebar** — the SightRead activity-bar container holds two views: **Segments** (the current function's segments, following the cursor) and **Markers** (every marker in the workspace, grouped by file — click to jump, trash to delete).

## Settings

| Setting | Default | |
|---|---|---|
| `sightread.variableTint.enabled` | `true` | occurrence outlining on cursor move |
| `sightread.spotlight.defaultLevel` | `0` | spotlight level applied on startup (0–3) |
| `sightread.spotlight.functionDimOpacity` | `0.15` | dim level outside the function |
| `sightread.spotlight.segmentDimOpacity` | `0.4` | dim level for non-related code in the function |
| `sightread.spotlight.siblingDimOpacity` | `0.6` | dim level for siblings of the cursor's segment |
| `sightread.marker.notePosition` | `lineEnd` | marker note at line start or line end |

## Development

```bash
npm install
npm run compile     # type-check + lint + bundle
npm run test:unit   # fast pure-logic tests (mocha)
npm test            # full integration tests in a VS Code host
```

Press `F5` in VS Code to launch the Extension Development Host.

- `npm run watch` — incremental build (esbuild + tsc type-checking in parallel)
- `npm run package` — production bundle

Architecture (see design.md §四): `src/core/` is pure logic (segmentation, marker math, focus algebra — unit-tested, zero vscode imports); `src/vs/` is the platform layer, with **all** decorations flowing through a single compositor so the layers and the spotlight mode never fight over rendering.
