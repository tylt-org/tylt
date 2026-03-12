import process from 'node:process'
import {cp, writeFile} from 'node:fs/promises'
import {setTimeout} from 'node:timers/promises'
import {createWriteStream, type WriteStream} from 'node:fs'
import {join} from 'node:path'
import {type Workspace, type ContainerExecutor, type InputMount, type OutputMount, type CacheMount, type BindMount, type SetupPhase} from './engine/index.js'
import {ContainerCrashError, TyltError} from './errors.js'
import type {Step} from './types.js'
import type {Reporter, StepRef, JobContext} from './reporter.js'
import {CacheLockManager} from './cache-lock.js'
import {StateManager} from './state.js'
import {dirSize, resolveHostPath} from './utils.js'

export type StepRunResult = {
  runId?: string;
  exitCode: number;
}

export type StepRunOptions = {
  workspace: Workspace;
  state: StateManager;
  step: Step;
  inputs: Map<string, string>;
  pipelineRoot: string;
  force?: boolean;
  ephemeral?: boolean;
  job: JobContext;
}

type ExecutionContext = {
  workspace: Workspace;
  state: StateManager;
  step: Step;
  stepRef: StepRef;
  inputs: Map<string, string>;
  pipelineRoot: string;
  ephemeral?: boolean;
  currentFingerprint: string;
  resolvedMounts?: Array<{hostPath: string; containerPath: string}>;
  job: JobContext;
}

/**
 * Executes a single step in a workspace.
 * Adapted from PipelineRunner.executeStep() for standalone use.
 */
export class StepRunner {
  private readonly cacheLocks = new CacheLockManager()

  constructor(
    private readonly runtime: ContainerExecutor,
    private readonly reporter: Reporter
  ) {}

  async run(options: StepRunOptions): Promise<StepRunResult> {
    const {workspace, state, step, inputs, pipelineRoot, force, ephemeral, job} = options
    const stepRef: StepRef = {id: step.id, displayName: step.name ?? step.id}

    const resolvedMounts = step.mounts?.map(m => ({
      hostPath: resolveHostPath(pipelineRoot, m.host),
      containerPath: m.container
    }))
    const currentFingerprint = this.computeFingerprint(step, inputs, resolvedMounts)

    // Cache check (skip for ephemeral or force)
    if (!force && !ephemeral) {
      const cacheResult = await this.tryUseCache({workspace, state, stepId: step.id, stepRef, fingerprint: currentFingerprint, job})
      if (cacheResult) {
        return cacheResult
      }
    }

    this.reporter.emit({...job, event: 'STEP_STARTING', step: stepRef})
    return this.executeStep({workspace, state, step, stepRef, inputs, pipelineRoot, ephemeral, currentFingerprint, resolvedMounts, job})
  }

  private computeFingerprint(
    step: Step,
    inputs: Map<string, string>,
    resolvedMounts?: Array<{hostPath: string; containerPath: string}>
  ): string {
    const inputRunIds = step.inputs
      ?.map(i => inputs.get(i.step))
      .filter((id): id is string => id !== undefined)
    return StateManager.fingerprint({
      image: step.image,
      cmd: step.cmd,
      setup: step.setup ? {cmd: step.setup.cmd} : undefined,
      env: step.env,
      inputRunIds,
      mounts: resolvedMounts
    })
  }

  private async tryUseCache({workspace, state, stepId, stepRef, fingerprint, job}: {
    workspace: Workspace;
    state: StateManager;
    stepId: string;
    stepRef: StepRef;
    fingerprint: string;
    job: JobContext;
  }): Promise<StepRunResult | undefined> {
    const cached = state.getStep(stepId)
    if (cached?.fingerprint === fingerprint) {
      const runs = await workspace.listRuns()
      if (runs.includes(cached.runId)) {
        await workspace.linkRun(stepId, cached.runId)
        this.reporter.emit({...job, event: 'STEP_SKIPPED', step: stepRef, runId: cached.runId, reason: 'cached'})
        return {runId: cached.runId, exitCode: 0}
      }
    }

    return undefined
  }

  private async executeStep(ctx: ExecutionContext): Promise<StepRunResult> {
    const {workspace, step, stepRef, inputs, pipelineRoot, ephemeral, job} = ctx
    const runId = workspace.generateRunId()
    const stagingPath = await workspace.prepareRun(runId)

    await this.prepareStagingInputs(workspace, step, runId, inputs)
    await this.prepareCaches(workspace, step)

    const {containerInputs, output, caches, mounts} = this.buildMounts(step, runId, inputs, pipelineRoot)

    // Acquire exclusive locks for setup caches
    const exclusiveCacheNames = step.setup?.caches
      ?.filter(c => c.exclusive)
      .map(c => c.name) ?? []
    let releaseLocks: (() => void) | undefined
    if (exclusiveCacheNames.length > 0) {
      releaseLocks = await this.cacheLocks.acquire(exclusiveCacheNames)
    }

    const stdoutLog = createWriteStream(join(stagingPath, 'stdout.log'))
    const stderrLog = createWriteStream(join(stagingPath, 'stderr.log'))

    try {
      const result = await this.executeWithRetries({
        ctx, containerInputs, output, caches, mounts, stdoutLog, stderrLog, releaseLocks
      })

      await closeStream(stdoutLog)
      await closeStream(stderrLog)

      if (ephemeral) {
        await workspace.discardRun(runId)
        this.reporter.emit({...job, event: 'STEP_FINISHED', step: stepRef, ephemeral: true})
        return {exitCode: result.exitCode}
      }

      return await this.commitOrDiscard({...ctx, runId, stagingPath, result})
    } catch (error) {
      await closeStream(stdoutLog)
      await closeStream(stderrLog)
      throw error
    } finally {
      releaseLocks?.()
    }
  }

  private async prepareStagingInputs(workspace: Workspace, step: Step, runId: string, inputs: Map<string, string>): Promise<void> {
    if (!step.inputs) {
      return
    }

    for (const input of step.inputs) {
      const inputRunId = inputs.get(input.step)
      if (inputRunId && input.copyToOutput) {
        await cp(workspace.runArtifactsPath(inputRunId), workspace.runStagingArtifactsPath(runId), {recursive: true})
      }
    }
  }

  private async prepareCaches(workspace: Workspace, step: Step): Promise<void> {
    if (step.caches) {
      for (const cache of step.caches) {
        await workspace.prepareCache(cache.name)
      }
    }

    if (step.setup?.caches) {
      for (const cache of step.setup.caches) {
        await workspace.prepareCache(cache.name)
      }
    }
  }

  private buildMounts(step: Step, runId: string, inputs: Map<string, string>, pipelineRoot: string) {
    const containerInputs: InputMount[] = []
    if (step.inputs) {
      for (const input of step.inputs) {
        const inputRunId = inputs.get(input.step)
        if (inputRunId) {
          containerInputs.push({runId: inputRunId, containerPath: `/input/${input.step}`})
        }
      }
    }

    const output: OutputMount = {stagingRunId: runId, containerPath: step.outputPath ?? '/output'}
    const caches: CacheMount[] | undefined = step.caches?.map(c => ({name: c.name, containerPath: c.path}))
    const mounts: BindMount[] | undefined = step.mounts?.map(m => ({
      hostPath: resolveHostPath(pipelineRoot, m.host),
      containerPath: m.container
    }))

    return {containerInputs, output, caches, mounts}
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

  private async executeWithRetries({ctx, containerInputs, output, caches, mounts, stdoutLog, stderrLog, releaseLocks}: {
    ctx: ExecutionContext;
    containerInputs: InputMount[];
    output: OutputMount;
    caches: CacheMount[] | undefined;
    mounts: BindMount[] | undefined;
    stdoutLog: WriteStream;
    stderrLog: WriteStream;
    releaseLocks?: () => void;
  }) {
    const {workspace, step, stepRef, pipelineRoot, ephemeral, job} = ctx
    const maxRetries = step.retries ?? 0
    const retryDelay = step.retryDelayMs ?? 5000
    const setup = this.buildSetupPhase(step)

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
            env: step.env,
            inputs: containerInputs,
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

            if (ephemeral && stream === 'stdout') {
              process.stdout.write(line + '\n')
            } else {
              this.reporter.emit({...job, event: 'STEP_LOG', step: stepRef, stream, line})
            }
          },
          async () => {
            releaseLocks?.()
          }
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

    return result
  }

  private async commitOrDiscard({workspace, state, step, stepRef, inputs, resolvedMounts, currentFingerprint, runId, stagingPath, result, job}: ExecutionContext & {
    runId: string;
    stagingPath: string;
    result: {exitCode: number; startedAt: Date; finishedAt: Date};
  }): Promise<StepRunResult> {
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
      env: step.env,
      inputs: step.inputs?.map(i => ({
        step: i.step,
        runId: inputs.get(i.step),
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

    if (result.exitCode === 0 || step.allowFailure) {
      await workspace.commitRun(runId)
      await workspace.linkRun(step.id, runId)
      state.setStep(step.id, runId, currentFingerprint)
      await state.save()

      const durationMs = result.finishedAt.getTime() - result.startedAt.getTime()
      const artifactSize = await dirSize(workspace.runArtifactsPath(runId))
      this.reporter.emit({...job, event: 'STEP_FINISHED', step: stepRef, runId, durationMs, artifactSize})
      return {runId, exitCode: result.exitCode}
    }

    await workspace.discardRun(runId)
    this.reporter.emit({...job, event: 'STEP_FAILED', step: stepRef, exitCode: result.exitCode})
    throw new ContainerCrashError(step.id, result.exitCode)
  }
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
