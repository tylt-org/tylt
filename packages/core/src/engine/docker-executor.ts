import process from 'node:process'
import {execa} from 'execa'
import {DockerNotAvailableError, ImagePullError, ContainerTimeoutError} from '../errors.js'
import type {RunContainerRequest, RunContainerResult, CacheMount} from './types.js'
import {ContainerExecutor, type OnLogLine} from './executor.js'
import type {Workspace} from './workspace.js'

/**
 * Build a minimal environment for the Docker CLI process.
 * Only PATH, HOME, and DOCKER_* are kept — everything else is stripped
 * so that host secrets (API keys, tokens, credentials) never leak,
 * even if a `-e KEY` (without value) were accidentally added.
 */
function dockerCliEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && (key === 'PATH' || key === 'HOME' || key.startsWith('DOCKER_'))) {
      env[key] = value
    }
  }

  return env
}

export class DockerCliExecutor extends ContainerExecutor {
  private readonly env = dockerCliEnv()
  private readonly activeContainers = new Set<string>()

  async check(): Promise<void> {
    try {
      await execa('docker', ['--version'], {env: this.env})
    } catch (error) {
      throw new DockerNotAvailableError({cause: error})
    }
  }

  /**
   * Force-remove all containers currently being executed by this process.
   */
  async killRunningContainers(): Promise<void> {
    const names = [...this.activeContainers]
    if (names.length === 0) {
      return
    }

    try {
      await execa('docker', ['rm', '-f', ...names], {env: this.env, reject: false})
    } catch {
      // Best effort
    }
  }

  /**
   * Remove any leftover tylt containers for the given workspace.
   * Called before pipeline execution to clean up after crashes.
   */
  async cleanupContainers(workspaceId: string): Promise<void> {
    try {
      const {stdout} = await execa('docker', [
        'ps', '-a', '--filter', `label=tylt.workspace=${workspaceId}`, '-q'
      ], {env: this.env})

      const ids = stdout.trim().split('\n').filter(Boolean)
      if (ids.length > 0) {
        await execa('docker', ['rm', '-f', ...ids], {env: this.env, reject: false})
      }
    } catch {
      // Best effort
    }
  }

  async run(
    workspace: Workspace,
    request: RunContainerRequest,
    onLogLine: OnLogLine,
    onSetupComplete?: () => Promise<void>
  ): Promise<RunContainerResult> {
    if (request.setup) {
      return this.runWithSetup(workspace, request, onLogLine, onSetupComplete)
    }

    return this.runSimple(workspace, request, onLogLine)
  }

  /**
   * Original single-phase execution: docker create + docker cp + docker start -a.
   */
  private async runSimple(
    workspace: Workspace,
    request: RunContainerRequest,
    onLogLine: OnLogLine
  ): Promise<RunContainerResult> {
    const startedAt = new Date()
    const args = this.buildCreateArgs(workspace, request)
    args.push(request.image, ...request.cmd)

    let exitCode = 0
    let error: string | undefined
    this.activeContainers.add(request.name)

    try {
      await execa('docker', args, {env: this.env})

      await this.copySources(request)

      const proc = execa('docker', ['start', '-a', request.name], {
        env: this.env,
        reject: false,
        timeout: request.timeoutSec ? request.timeoutSec * 1000 : undefined
      })

      await this.streamLogs(proc, onLogLine)
      const result = await proc
      exitCode = result.exitCode ?? 0
    } catch (error_) {
      ({exitCode, error} = this.handleRunError(error_, request))
    } finally {
      await this.cleanup(request.name)
    }

    return {exitCode, startedAt, finishedAt: new Date(), error}
  }

  /**
   * Two-phase execution: docker create (sleep) → docker exec (setup) → docker exec (run).
   */
  private async runWithSetup(
    workspace: Workspace,
    request: RunContainerRequest,
    onLogLine: OnLogLine,
    onSetupComplete?: () => Promise<void>
  ): Promise<RunContainerResult> {
    const startedAt = new Date()
    const {setup} = request

    // Determine network for setup vs run
    const setupNeedsNetwork = setup!.allowNetwork
    const runNetwork = request.network
    const createNetwork = setupNeedsNetwork ? 'bridge' : runNetwork

    // Build create args with sleep entrypoint to keep container alive
    const args = this.buildCreateArgs(workspace, request, {
      networkOverride: createNetwork,
      setupCaches: setup!.caches
    })
    args.push('--entrypoint', 'sleep', request.image, 'infinity')

    let exitCode = 0
    let error: string | undefined
    this.activeContainers.add(request.name)

    try {
      await execa('docker', args, {env: this.env})

      await this.copySources(request)

      // Start container detached (sleep infinity keeps it alive)
      await execa('docker', ['start', request.name], {env: this.env})

      // Setup phase
      exitCode = await this.dockerExec(request.name, setup!.cmd, onLogLine, request.timeoutSec)
      if (exitCode !== 0) {
        return {exitCode, startedAt, finishedAt: new Date(), error: 'setup phase failed'}
      }

      // Disconnect network if setup used bridge but run needs none
      if (createNetwork === 'bridge' && runNetwork === 'none') {
        await execa('docker', ['network', 'disconnect', 'bridge', request.name], {env: this.env, reject: false})
      }

      // Notify that setup is complete (releases cache locks)
      await onSetupComplete?.()

      // Run phase
      exitCode = await this.dockerExec(request.name, request.cmd, onLogLine, request.timeoutSec)
    } catch (error_) {
      ({exitCode, error} = this.handleRunError(error_, request))
    } finally {
      await onSetupComplete?.() // Safety net: ensure locks are released even on error
      await this.cleanup(request.name)
    }

    return {exitCode, startedAt, finishedAt: new Date(), error}
  }

  /**
   * Build common `docker create` arguments.
   */
  private buildCreateArgs(
    workspace: Workspace,
    request: RunContainerRequest,
    options?: {networkOverride?: string; setupCaches?: CacheMount[]}
  ): string[] {
    const network = options?.networkOverride ?? request.network
    const args = [
      'create',
      '--name',
      request.name,
      '--network',
      network,
      '--label',
      'tylt=true',
      '--label',
      `tylt.workspace=${workspace.id}`
    ]

    if (request.resourceLimits?.memory) {
      args.push('--memory', request.resourceLimits.memory)
    }

    if (request.resourceLimits?.cpus) {
      args.push('--cpus', request.resourceLimits.cpus)
    }

    if (request.env) {
      for (const [key, value] of Object.entries(request.env)) {
        args.push('-e', `${key}=${value}`)
      }
    }

    // Mount inputs (committed run artifacts, read-only)
    for (const input of request.inputs) {
      const hostPath = workspace.runArtifactsPath(input.runId)
      args.push('-v', `${hostPath}:${input.containerPath}:ro`)
    }

    // Mount caches (persistent, read-write)
    if (request.caches) {
      for (const cache of request.caches) {
        const hostPath = workspace.cachePath(cache.name)
        args.push('-v', `${hostPath}:${cache.containerPath}:rw`)
      }
    }

    // Mount setup-only caches (not duplicating any already in request.caches)
    if (options?.setupCaches) {
      const existingNames = new Set(request.caches?.map(c => c.name))
      for (const cache of options.setupCaches) {
        if (!existingNames.has(cache.name)) {
          const hostPath = workspace.cachePath(cache.name)
          args.push('-v', `${hostPath}:${cache.containerPath}:rw`)
        }
      }
    }

    // Mount host bind mounts (always read-only)
    if (request.mounts) {
      for (const mount of request.mounts) {
        args.push('-v', `${mount.hostPath}:${mount.containerPath}:ro`)
      }
    }

    // Mount output (staging run artifacts, read-write)
    const outputHostPath = workspace.runStagingArtifactsPath(request.output.stagingRunId)
    args.push('-v', `${outputHostPath}:${request.output.containerPath}:rw`)

    return args
  }

  /**
   * Copy source directories into the container's writable layer.
   */
  private async copySources(request: RunContainerRequest): Promise<void> {
    if (request.sources) {
      for (const source of request.sources) {
        await execa('docker', ['cp', `${source.hostPath}/.`, `${request.name}:${source.containerPath}`], {env: this.env})
      }
    }
  }

  /**
   * Execute a command in a running container, streaming logs.
   */
  private async dockerExec(
    containerName: string,
    cmd: string[],
    onLogLine: OnLogLine,
    timeoutSec?: number
  ): Promise<number> {
    const proc = execa('docker', ['exec', containerName, ...cmd], {
      env: this.env,
      reject: false,
      timeout: timeoutSec ? timeoutSec * 1000 : undefined
    })

    await this.streamLogs(proc, onLogLine)

    const result = await proc
    return result.exitCode ?? 0
  }

  /**
   * Stream stdout/stderr from a subprocess via iterables.
   */
  private async streamLogs(
    proc: ReturnType<typeof execa>,
    onLogLine: OnLogLine
  ): Promise<void> {
    const stdoutDone = (async () => {
      for await (const line of proc.iterable({from: 'stdout'})) {
        onLogLine({stream: 'stdout', line: String(line)})
      }
    })()

    const stderrDone = (async () => {
      for await (const line of proc.iterable({from: 'stderr'})) {
        onLogLine({stream: 'stderr', line: String(line)})
      }
    })()

    await Promise.all([stdoutDone, stderrDone])
  }

  /**
   * Handle errors from docker operations.
   */
  private handleRunError(error_: unknown, request: RunContainerRequest): {exitCode: number; error: string | undefined} {
    if (error_ instanceof Error && 'timedOut' in error_ && error_.timedOut) {
      throw new ContainerTimeoutError(request.timeoutSec ?? 0, {cause: error_})
    }

    const stderr = error_ instanceof Error && 'stderr' in error_ ? String(error_.stderr) : ''
    if (/unable to find image|pull access denied|manifest unknown/i.test(stderr)) {
      throw new ImagePullError(request.image, {cause: error_})
    }

    return {
      exitCode: 1,
      error: error_ instanceof Error ? error_.message : String(error_)
    }
  }

  /**
   * Force-remove a container and release tracking.
   */
  private async cleanup(name: string): Promise<void> {
    this.activeContainers.delete(name)
    try {
      await execa('docker', ['rm', '-f', '-v', name], {env: this.env, reject: false})
    } catch {
      // Best effort cleanup
    }
  }
}
