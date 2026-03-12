// ---------------------------------------------------------------------------
// Shared pipeline domain types.
//
// These types are used by both the CLI runner and the kit system, and will
// also be consumed by future orchestrators (remote API, programmatic usage).
// ---------------------------------------------------------------------------

// -- Building blocks --------------------------------------------------------

/** Host-to-container bind mount (read-only at runtime). */
export type MountSpec = {
  /** Relative path from the pipeline file directory. */
  host: string;
  /** Absolute path inside the container. */
  container: string;
}

/** Reference to a previous step's artifact, mounted as read-only input. */
export type InputSpec = {
  /** ID of the step whose artifact to mount. */
  step: string;
  /** If true, the input artifact is copied into the output staging area before execution. */
  copyToOutput?: boolean;
  /** If true, the step can execute even when this input's step was skipped or failed. */
  optional?: boolean;
}

/** Persistent read-write cache mount, shared across steps and executions. */
export type CacheSpec = {
  /** Cache name, scoped to the workspace (e.g. "npm-cache"). */
  name: string;
  /** Absolute mount path inside the container. */
  path: string;
  /** When true, the cache is locked exclusively during the setup phase. */
  exclusive?: boolean;
}

/** Optional setup phase executed before the main command (e.g. dependency install). */
export type SetupSpec = {
  /** Command and arguments for the setup phase. */
  cmd: string[];
  /** Caches used during setup (e.g. package manager stores). */
  caches?: CacheSpec[];
  /** When true, setup gets network access even if the run phase is isolated. */
  allowNetwork?: boolean;
}

// -- Resolved types (after kit resolution) ----------------------------------

/**
 * A fully resolved step, ready for execution.
 * Always has an explicit image and cmd — kit shorthand has already been expanded.
 */
export type Step = {
  id: string;
  /** Human-readable display name. Falls back to `id` when absent. */
  name?: string;
  image: string;
  cmd: string[];
  /** Optional setup phase (dependency install) before the main command. */
  setup?: SetupSpec;
  env?: Record<string, string>;
  /** Path to a dotenv file (relative to the pipeline file). */
  envFile?: string;
  inputs?: InputSpec[];
  /** Container path for the output artifact (default: "/output"). */
  outputPath?: string;
  caches?: CacheSpec[];
  mounts?: MountSpec[];
  /** Host directories copied into the container's writable layer (not bind-mounted). */
  sources?: MountSpec[];
  timeoutSec?: number;
  /** Container resource limits enforced by the executor. */
  resourceLimits?: {
    /** Memory limit in Docker format (e.g. "512m", "1g"). */
    memory?: string;
    /** CPU limit (e.g. "0.5", "2"). */
    cpus?: string;
  };
  /** When true the pipeline continues even if this step exits non-zero. */
  allowFailure?: boolean;
  /** When true the container gets network access (default: isolated). */
  allowNetwork?: boolean;
  /** Number of retry attempts for transient errors (default: 0). */
  retries?: number;
  /** Delay in milliseconds between retry attempts (default: 5000). */
  retryDelayMs?: number;
  /** Jexl condition expression; step is skipped when it evaluates to falsy. */
  if?: string;
}

/** A pipeline whose steps have all been resolved. */
export type Pipeline = {
  id: string;
  /** Human-readable display name. Falls back to `id` when absent. */
  name?: string;
  steps: Step[];
  /** Absolute path to the pipeline's root directory (where the pipeline file lives). */
  root: string;
}

// -- Definition types (before kit resolution) -------------------------------

/**
 * A step defined via a kit: `uses` selects the kit, `with` passes parameters.
 * Mutually exclusive with Step (which requires image + cmd).
 *
 * All optional fields (env, caches, mounts…) merge with the kit's defaults,
 * with user-specified values taking priority.
 */
export type KitStepDefinition = {
  id?: string;
  /** Human-readable display name. At least one of `id` or `name` must be provided. */
  name?: string;
  /** Kit name (e.g. "node", "python", "bash"). */
  uses: string;
  /** Kit-specific parameters (e.g. { version: "24", script: "build.js" }). */
  with?: Record<string, unknown>;
  /** Optional setup phase override (merged with kit defaults). */
  setup?: SetupSpec;
  env?: Record<string, string>;
  /** Path to a dotenv file (relative to the pipeline file). */
  envFile?: string;
  inputs?: InputSpec[];
  outputPath?: string;
  caches?: CacheSpec[];
  mounts?: MountSpec[];
  sources?: MountSpec[];
  timeoutSec?: number;
  /** Container resource limits enforced by the executor. */
  resourceLimits?: {
    /** Memory limit in Docker format (e.g. "512m", "1g"). */
    memory?: string;
    /** CPU limit (e.g. "0.5", "2"). */
    cpus?: string;
  };
  allowFailure?: boolean;
  allowNetwork?: boolean;
  retries?: number;
  retryDelayMs?: number;
  if?: string;
}

/**
 * A step definition with explicit image and cmd.
 * `id` is optional in definitions — derived from `name` via slugify if missing.
 */
export type RawStepDefinition = Omit<Step, 'id'> & {id?: string}

/** A step as written in the pipeline definition — either fully specified or using a kit. */
export type StepDefinition = RawStepDefinition | KitStepDefinition

/** A pipeline definition as written in JSON, before kit resolution. */
export type PipelineDefinition = {
  id?: string;
  name?: string;
  steps: StepDefinition[];
}

/** Type guard: returns true when the step uses a kit (`uses` field present). */
export function isKitStep(step: StepDefinition): step is KitStepDefinition {
  return 'uses' in step && typeof step.uses === 'string'
}

// -- Configuration -----------------------------------------------------------

/** Project-level configuration (`.tylt.yml`). */
export type TyltConfig = {
  /** Kit aliases: maps a short name to a file path or npm module specifier. */
  kits?: Record<string, string>;
  /** When true, `tylt run` launches a daemon and returns immediately. */
  detach?: boolean;
}

// -- Kit types ---------------------------------------------------------------

/** Output of a kit's resolve() method — a partially resolved step. */
export type KitOutput = Omit<Step, 'id' | 'name' | 'inputs' | 'outputPath' | 'timeoutSec' | 'allowFailure'>

/** Context passed to kit resolve() for companion files and chaining. */
export type KitResolveContext = {
  /** Absolute path to the kit's directory (for referencing companion files). */
  kitDir: string;
  /** Resolve another kit by name (for kit chaining/composition). */
  resolveKit: (name: string) => Promise<Kit>;
}

/** A reusable step template with parameter-based resolution. */
export type Kit = {
  name: string;
  /** Absolute path to the kit's directory (set for external kits). */
  kitDir?: string;
  resolve(params: Record<string, unknown>, context?: KitResolveContext): KitOutput | Promise<KitOutput>;
}

/** Context for resolving kits (project config, working directory, custom kits). */
export type KitContext = {
  /** Project-level config (kit aliases). */
  config: TyltConfig;
  /** Working directory (used to locate `kits/` directory). */
  cwd: string;
  /** Custom kits added by the user (merged with built-in defaults). */
  kits?: Map<string, Kit>;
}
