# SightRead

**English** | [简体中文](README-CN.md)

A code-reading enhancer for the vibe-coding era, focused on the micro-scale reading of code. Highlighting, marking, one-key fold/unfold, visual reinforcement of code segments — so you can understand code **in place**.

> Sibling project of [Navigation History](https://github.com/pyeprog/navigation-history).

## Why

![babel](./media/babel-towel.jpg)

> Those who don't read the code cannot steer the product, cannot control the quality of the project, and cannot learn anything.

You let an agent write the code — but if you never read that code, whatever it writes has nothing to do with you.
Idea is cheap, code is even cheaper these days. AI is your tool, not your master. And what still matters these days is your experience of your own adventure.

To be fair, reading or not reading the code is often not really a question — merely a choice of values.
This extension offers some visual assistance to those who still want to read code, hoping it helps you read faster and smoother.

Humans are no longer the main producers of code — machines are. Reading code, understanding it and making decisions is today's bottleneck. Facing a wall of code, an LLM can lay out the big structure and framework for you, but it cannot do the close reading for you (reading the detailed code costs the same as reading the LLM's summary of it).
SightRead goes the opposite way: no LLM required, it strengthens the *human* ability to read itself, draping a layer of visual aids over your code (toggleable at any time) — so that, like a musician sight-reading a score, the logical picture surfaces the moment you see the code.

![solennelle](./media/solennelle.webp)

## Features

![instruction](./media/demo.webp)

Five orthogonal features, each providing a different kind of visual assistance (see design.md §2):

- **Skeleton fold** — quickly fold and unfold the existing blocks inside a function. When reading a function, fold everything first to see its large structure, then expand the blocks you're interested in and read them closely.
- **Highlighter (markers)** — for the hard-to-read, tricky blocks: swipe a highlighter mark over them first, optionally with a short note saying what the block does.
- **Variable tint** — within the context of the enclosing function, outlines the symbol under the cursor, so you can see at a glance where this variable was created and where it is used.
- **Spotlight** — removes the visual noise of other functions and unrelated blocks. Click the 👁 item in the status bar to cycle Off → Seg+Var → Seg → Fn.
  1. **Fn** — only the current function; other functions are dimmed
  2. **Seg** — only the current block; other blocks are dimmed
  3. **Seg+Var** — the current block plus the related blocks; everything else is dimmed — the mode I use the most.
  4. **Off** — spotlight off, the default mode.
- **Auto segmentation** — splits a function into a **recursive structure** by blank lines + keywords, so the Segments panel can show the function's large structure; click a node to jump to that block. Next to each node, a dimmed detail text shows its condensed condition or expression (hover for the full header line).
- **Sidebar** — the SightRead activity-bar container holds two views: **Segments** (the current function's segment tree) and **Markers** (all highlighter marks in the workspace).

## Settings

| Setting | Default | |
|---|---|---|
| `sightread.variableTint.enabled` | `true` | occurrence outlining on cursor move |
| `sightread.spotlight.defaultMode` | `off` | spotlight mode on startup (off / seg+var / seg / fn) |
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

Architecture (see design.md §四): `src/core/` is pure logic (segmentation, marker math, focus algebra — unit-tested, zero vscode imports); `src/vs/` is the platform layer, with **all** decoration rendering flowing through a single compositor.
