import {isAbsolute, relative} from 'node:path'
import {ValidationError} from './errors.js'
import {resolveKit} from './kit-registry.js'
import {isKitStep, type CacheSpec, type KitContext, type KitResolveContext, type KitStepDefinition, type MountSpec, type Step, type StepDefinition} from './types.js'
import {slugify, mergeEnv, mergeCaches, mergeMounts, mergeSetup} from './pipeline-loader.js'

/**
 * Resolves a step definition into a fully resolved Step.
 * Kit steps (`uses`) are expanded into image + cmd.
 *
 * When a KitContext is provided, user-defined kits are resolved via
 * alias, local `kits/` directory, builtins, or npm modules.
 *
 * When pipelineRoot is provided, absolute host paths from kit output
 * are converted to pipelineRoot-relative paths before validation.
 */
export async function resolveStep(step: StepDefinition, context?: KitContext, pipelineRoot?: string): Promise<Step> {
  if (!step.id && !step.name) {
    throw new ValidationError('Invalid step: at least one of "id" or "name" must be defined')
  }

  const id = step.id ?? slugify(step.name!)
  const {name} = step

  if (!isKitStep(step)) {
    return {...step, id, name}
  }

  return resolveKitStep(step, id, name, {context, pipelineRoot})
}

/** Convert absolute host paths to pipelineRoot-relative paths. */
function relativizeMounts(mounts: MountSpec[] | undefined, pipelineRoot: string): MountSpec[] | undefined {
  if (!mounts) {
    return undefined
  }

  return mounts.map(mount => {
    if (isAbsolute(mount.host)) {
      return {...mount, host: relative(pipelineRoot, mount.host)}
    }

    return mount
  })
}

async function resolveKitStep(step: KitStepDefinition, id: string, name: string | undefined, options?: {context?: KitContext; pipelineRoot?: string}): Promise<Step> {
  const {context, pipelineRoot} = options ?? {}
  const kit = await resolveKit(step.uses, context)

  // Build KitResolveContext if kit has a kitDir
  let kitResolveCtx: KitResolveContext | undefined
  if (kit.kitDir) {
    kitResolveCtx = {
      kitDir: kit.kitDir,
      resolveKit: async (kitName: string) => resolveKit(kitName, context)
    }
  }

  const kitOutput = await kit.resolve(step.with ?? {}, kitResolveCtx)

  // Convert absolute host paths from kit output to pipelineRoot-relative
  let kitMounts = kitOutput.mounts
  let kitSources = kitOutput.sources
  if (pipelineRoot) {
    kitMounts = relativizeMounts(kitMounts, pipelineRoot)
    kitSources = relativizeMounts(kitSources, pipelineRoot)
  }

  return {
    id,
    name,
    image: kitOutput.image,
    cmd: kitOutput.cmd,
    setup: mergeSetup(kitOutput.setup, step.setup),
    env: mergeEnv(kitOutput.env, step.env),
    envFile: step.envFile,
    inputs: step.inputs,
    outputPath: step.outputPath,
    caches: mergeCaches(kitOutput.caches, step.caches),
    mounts: mergeMounts(kitMounts, step.mounts),
    sources: mergeMounts(kitSources, step.sources),
    timeoutSec: step.timeoutSec,
    resourceLimits: step.resourceLimits ?? kitOutput.resourceLimits,
    allowFailure: step.allowFailure,
    allowNetwork: step.allowNetwork ?? kitOutput.allowNetwork,
    retries: step.retries,
    retryDelayMs: step.retryDelayMs,
    if: step.if
  }
}

/**
 * Validates a resolved step for correctness and security.
 */
export function validateStep(step: Step): void {
  validateIdentifier(step.id, 'step id')

  if (!step.image || typeof step.image !== 'string') {
    throw new ValidationError(`Invalid step ${step.id}: image is required`)
  }

  if (!Array.isArray(step.cmd) || step.cmd.length === 0) {
    throw new ValidationError(`Invalid step ${step.id}: cmd must be a non-empty array`)
  }

  if (step.envFile) {
    if (typeof step.envFile !== 'string') {
      throw new ValidationError(`Step ${step.id}: envFile must be a string`)
    }

    if (step.envFile.startsWith('/')) {
      throw new ValidationError(`Step ${step.id}: envFile '${step.envFile}' must be a relative path`)
    }
  }

  if (step.inputs) {
    for (const input of step.inputs) {
      validateIdentifier(input.step, `input step name in step ${step.id}`)
    }
  }

  if (step.mounts) {
    validateMounts(step.id, step.mounts)
  }

  if (step.sources) {
    validateMounts(step.id, step.sources)
  }

  if (step.caches) {
    validateCaches(step.id, step.caches)
  }

  if (step.setup) {
    if (!Array.isArray(step.setup.cmd) || step.setup.cmd.length === 0) {
      throw new ValidationError(`Invalid step ${step.id}: setup.cmd must be a non-empty array`)
    }

    if (step.setup.caches) {
      validateCaches(step.id, step.setup.caches)
    }
  }
}

function validateIdentifier(id: string, context: string): void {
  if (!/^[\w-]+$/.test(id)) {
    throw new ValidationError(`Invalid ${context}: '${id}' must contain only alphanumeric characters, underscore, and hyphen`)
  }

  if (id.includes('..')) {
    throw new ValidationError(`Invalid ${context}: '${id}' cannot contain '..'`)
  }
}

function validateMounts(stepId: string, mounts: MountSpec[]): void {
  for (const mount of mounts) {
    if (!mount.host || typeof mount.host !== 'string') {
      throw new ValidationError(`Step ${stepId}: mount.host is required and must be a string`)
    }

    if (mount.host.startsWith('/')) {
      throw new ValidationError(`Step ${stepId}: mount.host '${mount.host}' must be a relative path`)
    }

    if (!mount.container || typeof mount.container !== 'string') {
      throw new ValidationError(`Step ${stepId}: mount.container is required and must be a string`)
    }

    if (!mount.container.startsWith('/')) {
      throw new ValidationError(`Step ${stepId}: mount.container '${mount.container}' must be an absolute path`)
    }

    if (mount.container.includes('..')) {
      throw new ValidationError(`Step ${stepId}: mount.container '${mount.container}' must not contain '..'`)
    }
  }
}

function validateCaches(stepId: string, caches: CacheSpec[]): void {
  for (const cache of caches) {
    if (!cache.name || typeof cache.name !== 'string') {
      throw new ValidationError(`Step ${stepId}: cache.name is required and must be a string`)
    }

    validateIdentifier(cache.name, `cache name in step ${stepId}`)

    if (!cache.path || typeof cache.path !== 'string') {
      throw new ValidationError(`Step ${stepId}: cache.path is required and must be a string`)
    }

    if (!cache.path.startsWith('/')) {
      throw new ValidationError(`Step ${stepId}: cache.path '${cache.path}' must be an absolute path`)
    }
  }
}
