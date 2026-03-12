/**
 * Read-only bind mount of a host directory into the container.
 */
export type BindMount = {
  /** Absolute path on the host */
  hostPath: string;
  /** Absolute path in the container */
  containerPath: string;
}

/**
 * Read-only mount of a committed run's artifacts.
 * The run must exist in the workspace's runs/ directory.
 */
export type InputMount = {
  /** Identifier of the committed run whose artifacts to mount */
  runId: string;
  /** Path where the artifacts will be mounted inside the container (e.g., /input/step1) */
  containerPath: string;
}

/**
 * Read-write mount for the output of an execution.
 *
 * The container writes to the staging run's artifacts directory during execution.
 * After successful execution, the staging run is committed to runs/.
 * On failure, the staging run is discarded.
 */
export type OutputMount = {
  /** Identifier of the run being created (in staging/ during execution) */
  stagingRunId: string;
  /** Path where output will be mounted inside the container (typically /output) */
  containerPath: string;
}

/**
 * Read-write mount of a persistent cache directory.
 *
 * Caches are workspace-scoped persistent directories that survive
 * across executions. Unlike run artifacts (immutable outputs), caches
 * are mutable and shared between steps.
 *
 * Common use cases:
 * - Package manager stores (pnpm, npm, cargo)
 * - Build caches (gradle, maven, ccache)
 * - Downloaded assets
 */
export type CacheMount = {
  /** Cache name (e.g., "pnpm-store", "npm-cache") */
  name: string;
  /** Path where cache will be mounted in container */
  containerPath: string;
}

/**
 * Setup phase executed before the main command.
 * Used for dependency installation with exclusive cache locking and network access.
 */
export type SetupPhase = {
  /** Command and arguments for the setup phase. */
  cmd: string[];
  /** Additional caches needed only during setup. */
  caches?: CacheMount[];
  /** When true, setup runs with network access (bridge). */
  allowNetwork?: boolean;
}

/**
 * Request to execute a container with specified configuration.
 */
export type RunContainerRequest = {
  /** Container name (used for Docker container identification) */
  name: string;
  /** Docker image to run (e.g., alpine:3.19) */
  image: string;
  /** Command and arguments to execute */
  cmd: string[];
  /** Optional setup phase (runs before cmd with separate caches/network). */
  setup?: SetupPhase;
  /** Environment variables to pass to the container */
  env?: Record<string, string>;
  /** Input run artifacts to mount as read-only volumes */
  inputs: InputMount[];
  /** Output location to mount as read-write volume */
  output: OutputMount;
  /** Persistent caches to mount as read-write volumes */
  caches?: CacheMount[];
  /** Host bind mounts (always read-only) */
  mounts?: BindMount[];
  /** Host directories copied into the container's writable layer (not bind-mounted) */
  sources?: BindMount[];
  /** Network isolation mode */
  network: 'none' | 'bridge';
  /** Execution timeout in seconds (undefined = no timeout) */
  timeoutSec?: number;
  /** Container resource limits (enforced by the executor) */
  resourceLimits?: {
    /** Memory limit (Docker format, e.g., "512m", "1g") */
    memory?: string;
    /** CPU limit (e.g., "0.5", "2") */
    cpus?: string;
  };
}

/**
 * Result of a container execution.
 */
export type RunContainerResult = {
  /** Exit code (0 = success, non-zero = failure) */
  exitCode: number;
  /** Execution start timestamp */
  startedAt: Date;
  /** Execution end timestamp */
  finishedAt: Date;
  /** Error message if execution failed */
  error?: string;
}
