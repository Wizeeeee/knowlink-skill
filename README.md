# Knowlink Page — Knowledge Galaxy Page Generator

> Turn "knowledge point data" into "shareable interactive node pages".
> Input a typed JSON spec, output a self-contained HTML file (inline data + precomputed layout coordinates, rendered in-browser by `knowlink-core.js`).

[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green)](https://nodejs.org)

[中文文档](./README.zh-CN.md) · [KnowLink View (Chrome Extension)](https://github.com/Wizeeeee/knowlink-view)

## Features

- **Zero dependencies**: the CLI only uses Node built-in modules; the browser side has no external dependencies
- **Deterministic rendering**: seeded RNG — the same input always produces the same layout (golden-test friendly)
- **Schema validation**: input JSON is validated first, errors point to the exact field
- **Self-contained output**: a single HTML file with inline data + styles + engine, shareable offline
- **Canvas rendering**: zoom / pan / search / detail panel

## Quick Start

```bash
# Validate the input spec
node bin/knowlink-page.mjs validate examples/demo.json

# Render a self-contained HTML
node bin/knowlink-page.mjs render examples/demo.json out/demo.html

# Generate the demo page
node bin/knowlink-page.mjs demo
```

### Via npm (recommended)

```bash
npm install -g knowlink-page
knowlink-page validate examples/demo.json
knowlink-page render examples/demo.json out/demo.html
```

## Commands

| Command | Purpose |
|---|---|
| `validate <input.json> [--json]` | Schema validation (hand-written, zero-dependency), exit 0 means pass |
| `render <input.json> [output.html] [--json]` | Generate a self-contained HTML |
| `demo [out-dir]` | Generate the demo page (default `examples/out/demo.html`) |
| `doctor` | Check skill asset integrity |

## Input Spec

```json
{
  "meta": { "title": "Title", "subtitle": "optional", "locale": "zh-CN|en" },
  "points": [
    { "id": "kp-1", "title": "Short title", "text": "Detail text", "url": "source", "source": "source name" }
  ],
  "edges": [
    { "from": "kp-1", "to": "kp-2", "strength": 80, "reason": "ai-inferred" }
  ],
  "config": { "theme": "dark", "width": 1200, "height": 800 }
}
```

Full field semantics: [references/authoring-contract.md](./references/authoring-contract.md) · JSON Schema: [schemas/page.schema.json](./schemas/page.schema.json)

### Authoring Rules

1. **`title` is the node label**: ≤5 words is best (truncated at render time). `text` is used for keyword edges and the detail panel.
2. **Stable `id`**: explicit edges reference point ids. Defaults to `kp-<i>` when omitted.
3. **Edges are optional**: when omitted, the engine computes them automatically (same-source 100 / same-domain 75 / keyword overlap 5-60).
4. **`strength` 1-100**: controls edge thickness and galaxy clustering (≥15 participates in clustering).
5. **≤200 points**: more triggers a warning. Prefer trimming or grouping large graphs.

## Architecture

```
User requirement → write JSON spec
    ↓
validate (schema check)
    ↓
render (Node-side layout → serialize coordinates → inject template)
    ↓
Self-contained HTML (inline knowlink-core.js + data + styles)
```

```
knowlink-skill/
├── SKILL.md                    Skill definition (agent entry point)
├── bin/
│   └── knowlink-page.mjs         CLI (validate / render / demo / doctor)
├── lib/
│   ├── knowlink-core.js          Layout + render core (Node precompute + browser render)
│   └── utils.js                Shared utilities
├── assets/
│   └── template.html           Page template
├── schemas/
│   └── page.schema.json        Input spec JSON Schema
├── references/
│   └── authoring-contract.md   Field semantics / layout params / fix order
└── examples/
    ├── demo.json               Example input (deep learning concept graph)
    └── out/                    Generated output (gitignored)
```

## Design Notes

- **Layout/render separation**: layout functions never touch the DOM → coordinates can be precomputed in Node; render functions run in the browser
- **Deterministic**: seeded RNG, same input → same layout, golden-test friendly
- **Zero dependencies**: `knowlink-page.mjs` only uses `node:crypto` / `node:fs` / `node:path`

## Related Projects

- **[KnowLink View](https://github.com/Wizeeeee/knowlink-view)** — Chrome extension (Manifest V3) for collecting, managing and visualizing knowledge points in the browser. This skill generates shareable HTML pages from the same knowledge-point data model.

## Development

```bash
# Run tests
npm test

# Generate demo
npm run demo
```

### Publishing to npm

The package is published as **`knowlink-page`** on the npm registry.

```bash
# 1. Bump the version
npm version patch   # or minor / major

# 2. Publish (runs `npm test` automatically via prepublishOnly)
npm publish
```

## Contributing

Issues and Pull Requests are welcome!

## License

[MIT](./LICENSE)