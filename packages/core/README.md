# @tylt/core

Programmatic TypeScript API for the Tylt containerized pipeline engine.

Use this package to embed pipeline execution in your own tools, build custom orchestrators, or interact with workspaces and runs programmatically.

## Installation

```bash
npm install @tylt/core
```

## Usage

```typescript
import {Tylt} from '@tylt/core'

// Zero config — Docker runtime, console reporter, built-in kits (shell, node, python)
const tylt = new Tylt()

// Load from file or JS object
const pipeline = await tylt.load('./pipeline.yaml')
const pipeline = await tylt.load({
  id: 'my-pipeline',
  steps: [{id: 'greet', uses: 'shell', with: {run: 'echo hello'}}]
})

// Run the pipeline (all steps, or targeted)
await tylt.run(pipeline)
await tylt.run(pipeline, {target: ['greet']})

// Execute a single step in a workspace
const step = await tylt.loadStep('./step.yaml')
await tylt.exec('my-workspace', step, {inputs: ['download']})

// Workspace operations
const workspaces = await tylt.workspaces()             // list all
await tylt.removeWorkspace('old-build')                // remove
await tylt.clean()                                     // remove all

// Detached execution (daemon mode) — pass a resolved Pipeline
const pipeline = await tylt.load('./pipeline.yaml')
const handle = await tylt.runDetached(pipeline, {workspace: 'my-ws'})
// handle: { jobId, workspaceId, pid, socketPath }

const client = await tylt.attach('my-ws')               // attach to running daemon
client.on('event', event => { /* pipeline events */ })
client.on('done', success => { /* finished */ })

const lockInfo = await tylt.workspaceLock('my-ws')       // check if workspace is locked

const ws = await tylt.workspace('my-workspace')        // open existing
const info = await ws.show()                            // list steps
const logs = await ws.logs('download')                  // read logs
const meta = await ws.inspect('download')               // read metadata
const entries = await ws.listArtifacts('download')      // list artifacts
const buf = await ws.readArtifact('download', 'out.csv')// read artifact
await ws.exportArtifacts('download', './output')        // export to host
await ws.prune()                                        // remove old runs
await ws.removeStep('download')                         // remove step
await ws.remove()                                       // remove workspace
```

All options are optional:

```typescript
const tylt = new Tylt({
  workdir: './workdir',      // default: './workdir'
  kits: [{                   // custom kits (added to built-ins)
    name: 'rust',
    resolve: (params) => ({image: `rust:${params.version ?? '1'}`, cmd: ['cargo', 'run']})
  }]
})
```

## Custom Kits

Beyond the built-in kits (`shell`, `node`, `python`), you can register custom kits.

### Via `.tylt.yml` (CLI)

```yaml
kits:
  geo: ./kits/geo.js           # local file
  ml: @myorg/tylt-kit-ml      # npm package
```

### Via `Tylt` options (programmatic)

```typescript
const tylt = new Tylt({
  kits: [{
    name: 'rust',
    resolve: (params) => ({
      image: `rust:${params.version ?? '1'}`,
      cmd: ['cargo', 'run'],
      sources: [{host: params.src ?? '.', container: '/app'}]
    })
  }]
})
```

### As a JS module

A kit is a JS module exporting a default function that returns `{image, cmd}` (plus optional `setup`, `env`, `caches`, `mounts`, `sources`, `resourceLimits`):

```javascript
// kits/rust.js
export default function (params) {
  return {
    image: `rust:${params.version ?? '1'}`,
    cmd: ['cargo', 'run'],
    sources: [{host: params.src ?? '.', container: '/app'}]
  }
}
```

### Kit resolution order

When a step uses `uses: <name>`, the kit is resolved in this order:

1. **`.tylt.yml` aliases** — mapped name → file path or npm specifier
2. **`kits/<name>/index.js`** — local directory
3. **`kits/<name>.js`** — local file
4. **Custom kits** — kits passed via `new Tylt({kits: [...]})`
5. **Built-in** — `shell`, `node`, `python`
6. **npm module** — for scoped packages (`@org/kit-name`)

## Resource Limits

Cap memory and CPU per step with `resourceLimits`:

```yaml
- id: build
  image: node:22
  cmd: [npm, run, build]
  resourceLimits:
    memory: "1g"
    cpus: "2"
```

Or programmatically:

```typescript
const pipeline = await tylt.load({
  id: 'heavy',
  steps: [{
    id: 'train',
    image: 'python:3.12',
    cmd: ['python', 'train.py'],
    resourceLimits: {memory: '4g', cpus: '4'}
  }]
})
```

Both `memory` (Docker format: `"128m"`, `"2g"`) and `cpus` (`"0.5"`, `"4"`) are optional. Values are passed directly to the container runtime (`--memory`, `--cpus`). Kit steps can provide defaults; user-level values take precedence.

## Main Exports

### Tylt Facade

- **`Tylt`** — Main entry point. Configure once, load/run pipelines, exec single steps, manage workspaces. Built-in kits always available.
- **`TyltWorkspace`** — Workspace handle returned by `tylt.workspace()`. Provides show, logs, inspect, artifact read/export, prune, remove operations.

### Engine

- **`Workspace`** — Manages isolated execution environments (staging → commit lifecycle, artifact storage, caches)
- **`DockerCliExecutor`** — Runs containers via Docker CLI with mount configuration, log streaming, and two-phase execution
- **`ContainerExecutor`** — Abstract base class for pluggable container runtimes

### Orchestration

- **`PipelineRunner`** — DAG-based parallel step execution with fingerprint caching. Takes a `Pipeline` object.
- **`StepRunner`** — Single-step executor for interactive/exploratory workflows
- **`PipelineLoader`** — Constructor takes optional `KitContext`. Loads from file paths or JS objects (`PipelineDefinition`). Also provides `loadStep()`.
- **`StateManager`** — Persists step fingerprints and run IDs for cache hit detection
- **`CacheLockManager`** — In-memory async mutex for exclusive cache access during setup phases

### Built-in Kits

- **`defaultKits`** — Map of all built-in kits (shell, node, python)
- **`shellKit`**, **`nodeKit`**, **`pythonKit`** — Individual kit objects

### Kit Registry

- **`resolveKit(name, context?)`** — Resolves a kit by name: alias → local dir → local file → custom kits → built-in defaults → npm module
- **`loadExternalKit(specifier, cwd)`** — Loads a kit from a file path or npm specifier

### DAG Utilities

- **`buildGraph`**, **`validateGraph`**, **`topologicalLevels`**, **`subgraph`**, **`leafNodes`**

### Daemon

- **`DaemonClient`** — Connects to a running daemon via Unix socket. EventEmitter for pipeline events, status queries, and lifecycle management.
- **`DaemonServer`** — Socket server that runs pipelines in background, broadcasts events to connected clients.
- **`BroadcastReporter`** — Reporter that fans out pipeline events to multiple connected socket clients.
- **`WorkspaceLock`** — Exclusive workspace lock with PID-alive checks and stale lock cleanup.
- **`NdjsonEncoder`**, **`NdjsonDecoder`** — Newline-delimited JSON stream codec.

### Reporting

- **`ConsoleReporter`** — Structured JSON output via Pino
- **`StreamReporter`**, **`CompositeReporter`** — Composable event-based reporters
- **`EventAggregator`** — Aggregates pipeline events into session state

### Types

All domain types are exported: `Pipeline`, `Step`, `Kit`, `KitContext`, `KitOutput`, `StepDefinition`, `PipelineDefinition`, `TyltConfig`, etc.

### Errors

Structured error hierarchy: `TyltError` → `DockerError`, `WorkspaceError`, `PipelineError`, `KitError`, `DaemonError` with specific subclasses (`WorkspaceLockedError`, etc.).
