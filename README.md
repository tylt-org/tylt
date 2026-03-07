# Tylt

Containerized pipeline execution engine. Each step runs in an isolated Docker container with explicit inputs, outputs, and caching.

```yaml
name: data-pipeline
steps:
  - id: download
    uses: shell
    with:
      packages: [curl]
      run: curl -o /output/data.csv https://example.com/data.csv

  - id: analyze
    uses: python
    with: { script: analyze.py, src: scripts/ }
    inputs: [{ step: download }]

  - id: report
    uses: node
    with: { script: report.js, src: app/ }
    inputs: [{ step: analyze }]
```

```bash
npx @tylt/cli run
```

## Features

- 🐳 **Container isolation** — Every step runs in its own Docker container with controlled network access
- 🔀 **DAG execution** — Steps declare dependencies via `inputs`; independent steps run in parallel
- ⚡ **Fingerprint caching** — Steps are skipped when image, command, env, and inputs haven't changed
- 🧰 **Built-in kits** — `node`, `python`, `shell` with automatic dependency installation
- 🔒 **Two-phase execution** — Setup (install deps with network + cache locks) then run (isolated, parallel-safe)
- 🔌 **Custom kits** — Write your own as JS modules, distribute via npm
- 📦 **Artifact management** — Immutable runs with artifacts, logs, and structured metadata
- 🔄 **Detached execution** — Run pipelines in background, re-attach to monitor progress
- 🛠️ **Programmatic API** — Use `@tylt/core` to embed pipeline execution in your own tools
- 🔧 **Pluggable executor** — Swap the container runtime via `TYLT_EXECUTOR` (defaults to Docker CLI)

## Quick Start

```bash
npx @tylt/cli run pipeline.yaml
```

Or install globally:

```bash
npm install -g @tylt/cli
tylt run pipeline.yaml
```

## Packages

This is a monorepo with two packages:

| Package | npm | Description |
|---------|-----|-------------|
| [`@tylt/cli`](packages/cli/) | CLI | Command-line interface, interactive reporter |
| [`@tylt/core`](packages/core/) | Library | Programmatic TypeScript API: engine, orchestration, built-in kits, types |

## Custom Kits

Write reusable step templates as JS modules, reference them via `uses`. Configure aliases in `.tylt.yml`:

```yaml
# .tylt.yml
kits:
  geo: ./kits/geo.js
  ml: @myorg/tylt-kit-ml
```

See the [CLI README](packages/cli/README.md#custom-kits) for details on writing kits and resolution order.

## Examples

```bash
# Geodata: download → extract → list-files / build-csv (parallel)
tylt run examples/geodata/

# Text processing: parallel branches, conditional steps, optional inputs
tylt run examples/text-processing/

# Multi-language: Node.js + Python steps with automatic dependency install
tylt run examples/multi-language/
```

## Development

```bash
git clone https://github.com/tylt-org/tylt.git
cd tylt
npm install
```

```bash
npm run cli -- run pipeline.yaml   # Dev mode (tsx, no build needed)
npm run build                      # Compile all packages
npm run clean                      # Remove dist and tsbuildinfo
npm test                           # Run tests across all packages
npm run lint                       # Lint with XO
```
