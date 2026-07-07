# SightRead

A reading lens for code — highlight, dim, fold and outline function segments to help you understand code **in place**, right inside the editor.

> Status: early experiment (0.x). Sibling project of [Navigation History](https://github.com/pyeprog/navigation-history).

## Why

Reading a heavyweight (often vibe-coded) project is hard: you don't know where to start, the volume buries the skeleton, and LLM explanations live in a sidebar — detached from the code they explain. SightRead explores the opposite direction: keep the understanding **anchored** to real code positions, rendered with native editor primitives (decorations, folding, document symbols), all local and instant — no LLM required.

See [doc/discussion.md](doc/discussion.md) for the full design discussion (in Chinese): the three reading needs (find entries, see paths, understand one implementation), the footprint-vs-guide-map duality, the survey of existing tools, and the native VS Code hooks this plugin builds on.

## Development

```bash
npm install
npm run compile   # type-check + lint + bundle
```

Press `F5` in VS Code to launch the Extension Development Host.

- `npm run watch` — incremental build (esbuild + tsc type-checking in parallel)
- `npm run package` — production bundle
- `npm run lint` — ESLint over `src/`
