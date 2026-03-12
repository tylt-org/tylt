import process from 'node:process'
import {randomUUID} from 'node:crypto'
import {cpus} from 'node:os'
import {cp, writeFile} from 'node:fs/promises'
import {setTimeout} from 'node:timers/promises'
import {createWriteStream, type WriteStream} from 'node:fs'
import {join, resolve} from 'node:path'
import {Workspace, type ContainerExecutor, type InputMount, type OutputMount, type CacheMount, type BindMount, type SetupPhase} from './engine/index.js'
import {ContainerCrashError, TyltError} from './errors.js'
import {loadEnvFile} from './env-file.js'
import type {Pipeline, Step} from './types.js'
import type {Reporter, StepRef, JobContext} from './reporter.js'
import {buildGraph, topologicalLevels, subgraph, leafNodes} from './dag.js'
import {CacheLockManager} from './cache-lock.js'
import {evaluateCondition} from './condition.js'
import {StateManager} from './state.js'
import {dirSize, resolveHostPath} from './utils.js'

/**
 * Orchestrates pipeline execution with DAG-based parallel execution and caching.
 */
export class PipelineRunner {
  constructor(
    private readonly runtime: ContainerExecutor,
    private readonly reporter: Reporter,
    private readonly workdirRoot: string
  ) {}

  async run(pipeline: Pipeline, options?: {
    workspace?: string;
    force?: true | string[];
    dryRun?: boolean;
    target?: string[];
    concurrency?: number;
    envFile?: string;
  }): Promise<void> {
    const {workspace: workspaceName, force, dryRun, target, concurrency, envFile} = options ?? {}
    const pipelineRoot = pipeline.root

    const workspaceId = workspaceName ?? pipeline.id

    let workspace: Workspace
    try {
      workspace = await Workspace.open(this.workdirRoot, workspaceId)
    } catch {
      workspace = await Workspace.create(this.workdirRoot, workspaceId)
    }

    await workspace.cleanupStaging()
    await workspace.cleanupRunning()
    if (!dryRun) {
      await this.runtime.check()
      await this.runtime.cleanupContainers(workspace.id)
    }

    const cliEnv = envFile ? await loadEnvFile(resolve(envFile)) : undefined

    const state = new StateManager(workspace.root)
    await state.load()
    const stepRuns = new Map<string, string>()
    let totalArtifactSize = 0

    const job: JobContext = {workspaceId: workspace.id, jobId: randomUUID()}

    // Build DAG and determine execution scope
    const graph = buildGraph(pipeline.steps)
    const targets = target ?? leafNodes(graph)
    const activeSteps = subgraph(graph, targets)

    this.reporter.emit({
      ...job,
      event: 'PIPELINE_START',
      pipelineName: pipeline.name ?? pipeline.id,
      steps: pipeline.steps
        .filter(s => activeSteps.has(s.id))
        .map(s => ({id: s.id, displayName: s.name ?? s.id}))
    })
    const levels = topologicalLevels(graph)
      .map(level => level.filter(id => activeSteps.has(id)))
      .filter(level => level.length > 0)

    const stepMap = new Map(pipeline.steps.map(s => [s.id, s]))
    const failed = new Set<string>()
    const skipped = new Set<string>()
    const cacheLocks = new CacheLockManager()
    const maxConcurrency = concurrency ?? cpus().length

    for (const level of levels) {
      const tasks = level.map(stepId => async () => {
        const step = stepMap.get(stepId)!
        const stepRef: StepRef = {id: step.id, displayName: step.name ?? step.id}

        // Check if blocked by a failed/skipped required dependency
        if (this.isDependencyBlocked(step, failed, skipped)) {
          skipped.add(step.id)
          this.reporter.emit({...job, event: 'STEP_SKIPPED', step: stepRef, reason: 'dependency'})
          return 0
        }

        // Evaluate condition
        if (step.if) {
          const conditionMet = await evaluateCondition(step.if, {env: process.env})
          if (!conditionMet) {
            skipped.add(step.id)
            this.reporter.emit({...job, event: 'STEP_SKIPPED', step: stepRef, reason: 'condition'})
            return 0
          }
        }

        // Resolve env vars: CLI envFile < step envFile < step inline env
        const stepFileEnv = step.envFile
          ? await loadEnvFile(resolve(pipelineRoot, step.envFile))
          : undefined
        const resolvedEnv = (cliEnv ?? stepFileEnv ?? step.env)
          ? {...cliEnv, ...stepFileEnv, ...step.env}
          : undefined

        // Compute fingerprint
        const inputRunIds = step.inputs
          ?.map(i => stepRuns.get(i.step))
          .filter((id): id is string => id !== undefined)
        const resolvedMounts = step.mounts?.map(m => ({
          hostPath: resolveHostPath(pipelineRoot, m.host),
          containerPath: m.container
        }))
        const currentFingerprint = StateManager.fingerprint({
          image: step.image,
          cmd: step.cmd,
          setup: step.setup ? {cmd: step.setup.cmd} : undefined,
          env: resolvedEnv,
          inputRunIds,
          mounts: resolvedMounts
        })

        // Cache check
        const skipCache = force === true || (Array.isArray(force) && force.includes(step.id))
        if (!skipCache && await this.tryUseCache({workspace, state, step, stepRef, currentFingerprint, stepRuns, job})) {
          return 0
        }

        // Dry run
        if (dryRun) {
          this.reporter.emit({...job, event: 'STEP_WOULD_RUN', step: stepRef})
          return 0
        }

        // Execute
        this.reporter.emit({...job, event: 'STEP_STARTING', step: stepRef})
        return this.executeStep({workspace, state, step, stepRef, stepRuns, currentFingerprint, resolvedMounts, pipelineRoot, job, resolvedEnv, cacheLocks})
      })

      const results = await withConcurrency(tasks, maxConcurrency)

      // Collect results
      for (const [i, result] of results.entries()) {
        const stepId = level[i]
        if (result.status === 'fulfilled') {
          totalArtifactSize += result.value
        } else if (!failed.has(stepId)) {
          // Step threw an error (ContainerCrashError if not allowFailure)
          failed.add(stepId)
        }
      }

      await state.save()
    }

    if (failed.size > 0) {
      this.reporter.emit({...job, event: 'PIPELINE_FAILED'})
      // Re-throw the first failure to signal pipeline failure to the CLI
      const firstFailedId = [...failed][0]
      throw new ContainerCrashError(firstFailedId, 1)
    }

    this.reporter.emit({...job, event: 'PIPELINE_FINISHED', totalArtifactSize})
  }

  private isDependencyBlocked(step: Step, failed: Set<string>, skippedSteps: Set<string>): boolean {
    if (!step.inputs) {
      return false
    }

    return step.inputs.some(input => !input.optional && (failed.has(input.step) || skippedSteps.has(input.step)))
  }

  private async executeStep({workspace, state, step, stepRef, stepRuns, currentFingerprint, resolvedMounts, pipelineRoot, job, resolvedEnv, cacheLocks}: {
    workspace: Workspace;
    state: StateManager;
    step: Step;
    stepRef: StepRef;
    stepRuns: Map<string, string>;
    currentFingerprint: string;
    resolvedMounts?: Array<{hostPath: string; containerPath: string}>;
    pipelineRoot: string;
    job: JobContext;
    resolvedEnv?: Record<string, string>;
    cacheLocks: CacheLockManager;
  }): Promise<number> {
    const runId = workspace.generateRunId()
    const stagingPath = await workspace.prepareRun(runId)
    await workspace.markStepRunning(step.id, {startedAt: new Date().toISOString(), pid: process.pid, stepName: step.name})

    await this.prepareStagingWithInputs(workspace, step, workspace.runStagingArtifactsPath(runId), stepRuns)

    if (step.caches) {
      for (const cache of step.caches) {
        await workspace.prepareCache(cache.name)
      }
    }

    // Prepare setup caches
    if (step.setup?.caches) {
      for (const cache of step.setup.caches) {
        await workspace.prepareCache(cache.name)
      }
    }

    const {inputs, output, caches, mounts} = this.buildMounts(step, runId, stepRuns, pipelineRoot)
    const setup = this.buildSetupPhase(step)

    // Acquire exclusive locks for setup caches
    const exclusiveCacheNames = step.setup?.caches
      ?.filter(c => c.exclusive)
      .map(c => c.name) ?? []
    let releaseLocks: (() => void) | undefined
    if (exclusiveCacheNames.length > 0) {
      releaseLocks = await cacheLocks.acquire(exclusiveCacheNames)
    }

    const stdoutLog = createWriteStream(join(stagingPath, 'stdout.log'))
    const stderrLog = createWriteStream(join(stagingPath, 'stderr.log'))

    const onSetupComplete = async () => {
      releaseLocks?.()
      releaseLocks = undefined
    }

    try {
      const maxRetries = step.retries ?? 0
      const retryDelay = step.retryDelayMs ?? 5000

      let result!: Awaited<ReturnType<ContainerExecutor['run']>>
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          result = await this.runtime.run(
            workspace,
            {
              name: `tylt-${workspace.id}-${step.id}-${Date.now()}`,
              image: step.image,
              cmd: step.cmd,
              setup,
              env: resolvedEnv,
              inputs,
              output,
              caches,
              mounts,
              sources: step.sources?.map(m => ({
                hostPath: resolveHostPath(pipelineRoot, m.host),
                containerPath: m.container
              })),
              network: step.allowNetwork ? 'bridge' : 'none',
              timeoutSec: step.timeoutSec,
              resourceLimits: step.resourceLimits
            },
            ({stream, line}) => {
              if (stream === 'stdout') {
                stdoutLog.write(line + '\n')
              } else {
                stderrLog.write(line + '\n')
              }

              this.reporter.emit({...job, event: 'STEP_LOG', step: stepRef, stream, line})
            },
            onSetupComplete
          )
          break
        } catch (error) {
          if (error instanceof TyltError && error.transient && attempt < maxRetries) {
            this.reporter.emit({...job, event: 'STEP_RETRYING', step: stepRef, attempt: attempt + 1, maxRetries})
            await setTimeout(retryDelay)
            continue
          }

          throw error
        }
      }

      await closeStream(stdoutLog)
      await closeStream(stderrLog)

      await this.writeRunMeta(stagingPath, {runId, step, stepRuns, resolvedMounts, currentFingerprint, result, resolvedEnv})

      if (result.exitCode === 0 || step.allowFailure) {
        await workspace.commitRun(runId)
        await workspace.linkRun(step.id, runId)
        stepRuns.set(step.id, runId)

        state.setStep(step.id, runId, currentFingerprint)

        const durationMs = result.finishedAt.getTime() - result.startedAt.getTime()
        const artifactSize = await dirSize(workspace.runArtifactsPath(runId))
        this.reporter.emit({...job, event: 'STEP_FINISHED', step: stepRef, runId, durationMs, artifactSize})
        return artifactSize
      }

      await workspace.commitRun(runId)
      await workspace.linkRun(step.id, runId)
      state.setStep(step.id, runId, '')

      this.reporter.emit({...job, event: 'STEP_FAILED', step: stepRef, exitCode: result.exitCode})
      throw new ContainerCrashError(step.id, result.exitCode)
    } catch (error) {
      await closeStream(stdoutLog)
      await closeStream(stderrLog)
      throw error
    } finally {
      releaseLocks?.()
      await workspace.markStepDone(step.id)
    }
  }

  private async writeRunMeta(stagingPath: string, {runId, step, stepRuns, resolvedMounts, currentFingerprint, result, resolvedEnv}: {
    runId: string;
    step: Step;
    stepRuns: Map<string, string>;
    resolvedMounts?: Array<{hostPath: string; containerPath: string}>;
    currentFingerprint: string;
    result: {exitCode: number; startedAt: Date; finishedAt: Date};
    resolvedEnv?: Record<string, string>;
  }): Promise<void> {
    const meta = {
      runId,
      stepId: step.id,
      stepName: step.name,
      startedAt: result.startedAt.toISOString(),
      finishedAt: result.finishedAt.toISOString(),
      durationMs: result.finishedAt.getTime() - result.startedAt.getTime(),
      exitCode: result.exitCode,
      image: step.image,
      cmd: step.cmd,
      env: resolvedEnv,
      inputs: step.inputs?.map(i => ({
        step: i.step,
        runId: stepRuns.get(i.step),
        mountedAs: `/input/${i.step}`
      })),
      mounts: resolvedMounts,
      setup: step.setup
        ? {
          cmd: step.setup.cmd,
          caches: step.setup.caches?.map(c => c.name),
          allowNetwork: step.setup.allowNetwork ?? false
        }
        : undefined,
      caches: step.caches?.map(c => c.name),
      allowNetwork: step.allowNetwork ?? false,
      fingerprint: currentFingerprint,
      status: result.exitCode === 0 ? 'success' : 'failure'
    }
    await writeFile(join(stagingPath, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8')
  }

  private async tryUseCache({
    workspace,
    state,
    step,
    stepRef,
    currentFingerprint,
    stepRuns,
    job
  }: {
    workspace: Workspace;
    state: StateManager;
    step: {id: string; name?: string};
    stepRef: StepRef;
    currentFingerprint: string;
    stepRuns: Map<string, string>;
    job: JobContext;
  }): Promise<boolean> {
    const cached = state.getStep(step.id)
    if (cached?.fingerprint === currentFingerprint) {
      try {
        const runs = await workspace.listRuns()
        if (runs.includes(cached.runId)) {
          stepRuns.set(step.id, cached.runId)
          await workspace.linkRun(step.id, cached.runId)
          this.reporter.emit({...job, event: 'STEP_SKIPPED', step: stepRef, runId: cached.runId, reason: 'cached'})
          return true
        }
      } catch {
        // Run missing, proceed with execution
      }
    }

    return false
  }

  private buildSetupPhase(step: Step): SetupPhase | undefined {
    if (!step.setup) {
      return undefined
    }

    return {
      cmd: step.setup.cmd,
      caches: step.setup.caches?.map(c => ({name: c.name, containerPath: c.path})),
      allowNetwork: step.setup.allowNetwork
    }
  }

  private async prepareStagingWithInputs(
    workspace: Workspace,
    step: {id: string; inputs?: Array<{step: string; copyToOutput?: boolean; optional?: boolean}>},
    stagingArtifactsPath: string,
    stepRuns: Map<string, string>
  ): Promise<void> {
    if (!step.inputs) {
      return
    }

    for (const input of step.inputs) {
      const inputRunId = stepRuns.get(input.step)
      if (!inputRunId) {
        if (input.optional) {
          continue
        }

        // Non-optional input without a run — this shouldn't happen in DAG mode
        // but keep the continue for safety (the step may still work with bind mounts)
        continue
      }

      if (input.copyToOutput) {
        await cp(workspace.runArtifactsPath(inputRunId), stagingArtifactsPath, {recursive: true})
      }
    }
  }

  private buildMounts(
    step: {inputs?: Array<{step: string}>; outputPath?: string; caches?: Array<{name: string; path: string}>; mounts?: Array<{host: string; container: string}>},
    outputRunId: string,
    stepRuns: Map<string, string>,
    pipelineRoot: string
  ): {inputs: InputMount[]; output: OutputMount; caches?: CacheMount[]; mounts?: BindMount[]} {
    const inputs: InputMount[] = []

    if (step.inputs) {
      for (const input of step.inputs) {
        const inputRunId = stepRuns.get(input.step)
        if (inputRunId) {
          inputs.push({
            runId: inputRunId,
            containerPath: `/input/${input.step}`
          })
        }
      }
    }

    const output: OutputMount = {
      stagingRunId: outputRunId,
      containerPath: step.outputPath ?? '/output'
    }

    let caches: CacheMount[] | undefined
    if (step.caches) {
      caches = step.caches.map(c => ({
        name: c.name,
        containerPath: c.path
      }))
    }

    let mounts: BindMount[] | undefined
    if (step.mounts) {
      mounts = step.mounts.map(m => ({
        hostPath: resolveHostPath(pipelineRoot, m.host),
        containerPath: m.container
      }))
    }

    return {inputs, output, caches, mounts}
  }
}

async function withConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number
): Promise<Array<PromiseSettledResult<T>>> {
  const results: Array<PromiseSettledResult<T>> = Array.from({length: tasks.length})
  let next = 0

  async function worker() {
    while (next < tasks.length) {
      const i = next++
      try {
        results[i] = {status: 'fulfilled', value: await tasks[i]()}
      } catch (error) {
        results[i] = {status: 'rejected', reason: error}
      }
    }
  }

  await Promise.all(Array.from({length: Math.min(limit, tasks.length)}, async () => worker()))
  return results
}

async function closeStream(stream: WriteStream): Promise<void> {
  if (stream.destroyed) {
    return
  }

  return new Promise((resolve, reject) => {
    stream.end(() => {
      resolve()
    })
    stream.on('error', reject)
  })
}
