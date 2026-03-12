# Pipeline Format Reference

## Step Options

| Field           | Type                  | Description                                                     |
|-----------------|-----------------------|-----------------------------------------------------------------|
| `id`            | string                | Machine identifier (alphanumeric, dash, underscore)             |
| `name`          | string                | Human-readable label (at least one of `id`/`name` required)    |
| `image`         | string                | Docker image (required for raw steps)                           |
| `cmd`           | string[]              | Command to execute (required for raw steps)                     |
| `setup`         | SetupSpec             | Optional setup phase (cmd, caches with `exclusive`, allowNetwork) |
| `uses`          | string                | Kit name (required for kit steps, mutually exclusive with `image`/`cmd`) |
| `with`          | object                | Kit parameters                                                  |
| `inputs`        | InputSpec[]           | Previous steps to mount as read-only at `/input/{stepId}/`      |
| `env`           | Record<string,string> | Environment variables passed to the container                   |
| `envFile`       | string                | Path to a dotenv file (relative to pipeline file)               |
| `outputPath`    | string                | Output mount point (default: `/output`)                         |
| `mounts`        | MountSpec[]           | Host directories to bind mount read-only                        |
| `sources`       | MountSpec[]           | Host directories copied into the container's writable layer     |
| `caches`        | CacheSpec[]           | Persistent read-write directories shared across executions      |
| `if`            | string                | JEXL condition — step skipped when false                        |
| `timeoutSec`    | number                | Execution timeout in seconds                                    |
| `retries`       | number                | Retry attempts on transient failure                             |
| `retryDelayMs`  | number                | Delay between retries (default: 5000)                           |
| `resourceLimits`| object                | Container resource limits (`memory`, `cpus`) — see below        |
| `allowFailure`  | boolean               | Continue pipeline if step fails                                 |
| `allowNetwork`  | boolean               | Enable network access in the container                          |

## Environment Variables

Env vars can come from multiple sources. Merge priority (highest wins):

1. Step `env` (inline YAML)
2. Step `envFile` (per-step dotenv file)
3. CLI `--env-file` (global, applied to all steps)
4. Kit defaults

## Mounts

Mount host directories read-only into containers:

```yaml
mounts:
  - host: src/app        # relative path (from pipeline file directory)
    container: /app      # absolute path in container
```

Rules: `host` must be relative (may use `..` to reach sibling directories, but cannot escape `process.cwd()`), `container` must be absolute and cannot contain `..`. Containers cannot modify mounted host files.

## Sources

Copy host directories into the container's writable layer:

```yaml
sources:
  - host: src/app
    container: /app
```

Same path rules as mounts (`host` may use `..` but cannot escape `process.cwd()`). Files are snapshotted at step start. The container can create files alongside sources (e.g. `node_modules`).

**When to use `sources` vs `mounts`**:
- `sources`: step needs to write alongside source files (install deps, generate build artifacts)
- `mounts`: read-only access is sufficient (config, static data)

## Caches

Persistent read-write directories shared across steps and executions:

```yaml
caches:
  - name: pnpm-store
    path: /root/.local/share/pnpm/store
  - name: build-cache
    path: /tmp/cache
```

Caches are workspace-scoped (not global). Common uses: package manager caches, build caches, downloaded assets. Set `exclusive: true` on a cache to acquire an in-memory mutex during the setup phase, preventing concurrent writes from parallel steps.

## Setup Phase

Optional pre-execution phase for dependency installation. Runs before the main `cmd` in the same container.

```yaml
setup:
  cmd: [sh, -c, "apt-get update && apt-get install -y curl"]
  caches:
    - name: apt-cache
      path: /var/cache/apt
      exclusive: true
  allowNetwork: true
```

- `cmd`: command to run during setup (required if setup is present)
- `caches`: caches needed during setup; supports `exclusive: true` for mutex locking
- `allowNetwork`: enable network during setup even if the run phase is isolated

Built-in kits produce a `setup` phase automatically when `install` is enabled. For kit steps, user-level `setup` merges with kit defaults (user `cmd` overrides, caches merge by name, user `allowNetwork` overrides).

## Resource Limits

Constrain CPU and memory available to a container:

```yaml
- id: build
  image: node:22
  cmd: [npm, run, build]
  resourceLimits:
    memory: "1g"
    cpus: "2"
```

| Field    | Type   | Description                                      |
|----------|--------|--------------------------------------------------|
| `memory` | string | Memory limit in Docker format (`"128m"`, `"2g"`) |
| `cpus`   | string | CPU limit (`"0.5"` = half a core, `"4"` = four)  |

Both fields are optional. When omitted, the container runs without that limit. Values are passed directly to Docker (`--memory`, `--cpus`). Kit steps can also specify `resourceLimits`; user-level values override kit defaults.

## Conditional Steps

Use `if` with a [JEXL](https://github.com/TomFrost/Jexl) expression evaluated against environment variables via `env`:

```yaml
- id: deploy
  if: env.NODE_ENV == "production"
  uses: shell
  with:
    run: echo "Deploying..."

- id: notify
  if: env.CI
  uses: shell
  with:
    run: echo "Running in CI"
```

When a condition is false, the step is skipped. Steps with required (non-optional) inputs depending on a skipped step are also skipped.

## Caching and Workspaces

Workspace ID is determined by (in priority order):
1. `--workspace` CLI flag
2. Pipeline `id` (explicit or derived from `name`)

Steps are skipped when their fingerprint (SHA256 of image + cmd + setup cmd + resolved env including `envFile` and `--env-file` + sorted inputs + mounts) hasn't changed since the last successful run. Use `--force` to bypass.

## `.tylt.yml` Configuration

Place a `.tylt.yml` file at the project root:

```yaml
kits:
  geo: ./kits/geo.js        # kit alias → local file or npm specifier
  ml: @myorg/tylt-kit-ml

detach: true                 # default execution mode: daemon (background)
```

| Field | Type | Description |
|-------|------|-------------|
| `kits` | Record<string, string> | Kit aliases (name → file path or npm specifier) |
| `detach` | boolean | When `true`, `tylt run` launches a daemon and returns immediately (default: `false`) |
