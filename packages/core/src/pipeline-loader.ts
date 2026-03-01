import {readFile} from 'node:fs/promises'
import process from 'node:process'
import {dirname, extname, resolve} from 'node:path'
import {parse as parseYaml} from 'yaml'
import {ValidationError} from './errors.js'
import type {CacheSpec, KitContext, MountSpec, Pipeline, PipelineDefinition, SetupSpec, Step, StepDefinition} from './types.js'
import {buildGraph, validateGraph} from './dag.js'
import {resolveStep, validateStep} from './step-resolver.js'

export class PipelineLoader {
  constructor(private readonly kitContext?: KitContext) {}

  async load(input: string | PipelineDefinition): Promise<Pipeline> {
    if (typeof input === 'string') {
      const content = await readFile(input, 'utf8')
      return this.parse(content, input)
    }

    // JS object: no file path, set root to cwd
    return this.resolve(input, process.cwd())
  }

  async parse(content: string, filePath: string): Promise<Pipeline> {
    const input = parsePipelineFile(content, filePath) as PipelineDefinition
    const pipelineRoot = dirname(resolve(filePath))
    return this.resolve(input, pipelineRoot)
  }

  async loadStep(filePath: string, stepIdOverride?: string): Promise<Step> {
    const content = await readFile(filePath, 'utf8')
    const raw = parsePipelineFile(content, filePath) as StepDefinition

    if (!raw || typeof raw !== 'object') {
      throw new ValidationError('Step file must contain an object')
    }

    // If no id/name provided, require --step override
    if (!('id' in raw && raw.id) && !('name' in raw && raw.name) && !stepIdOverride) {
      throw new ValidationError('Step file must have "id" or "name", or use --step to set an ID')
    }

    // Apply step ID override
    if (stepIdOverride) {
      (raw as Record<string, unknown>).id = stepIdOverride
    }

    const pipelineRoot = dirname(resolve(filePath))
    const step = await resolveStep(raw, this.kitContext, pipelineRoot)
    validateStep(step)
    return step
  }

  private async resolve(input: PipelineDefinition, pipelineRoot: string): Promise<Pipeline> {
    if (!input.id && !input.name) {
      throw new ValidationError('Invalid pipeline: at least one of "id" or "name" must be defined')
    }

    const pipelineId = input.id ?? slugify(input.name!)

    if (!Array.isArray(input.steps) || input.steps.length === 0) {
      throw new ValidationError('Invalid pipeline: steps must be a non-empty array')
    }

    const steps = await Promise.all(input.steps.map(async step => resolveStep(step, this.kitContext, pipelineRoot)))

    for (const step of steps) {
      validateStep(step)
    }

    this.validateUniqueStepIds(steps)

    const graph = buildGraph(steps)
    validateGraph(graph, steps)

    return {id: pipelineId, name: input.name, steps, root: pipelineRoot}
  }

  private validateUniqueStepIds(steps: Step[]): void {
    const seen = new Set<string>()
    for (const step of steps) {
      if (seen.has(step.id)) {
        throw new ValidationError(`Duplicate step id: '${step.id}'`)
      }

      seen.add(step.id)
    }
  }
}

/** Convert a free-form name into a valid identifier. */
export function slugify(name: string): string {
  return name.normalize('NFD').replaceAll(/[\u0300-\u036F]/g, '')
    .toLowerCase()
    .replaceAll(/[^\w-]/g, '-')
    .replaceAll(/-{2,}/g, '-')
    .replace(/^-/, '')
    .replace(/-$/, '')
}

export function parsePipelineFile(content: string, filePath: string): unknown {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.yaml' || ext === '.yml') {
    return parseYaml(content)
  }

  return JSON.parse(content)
}

export function mergeEnv(
  kitEnv?: Record<string, string>,
  userEnv?: Record<string, string>
): Record<string, string> | undefined {
  if (!kitEnv && !userEnv) {
    return undefined
  }

  return {...kitEnv, ...userEnv}
}

export function mergeCaches(
  kitCaches?: CacheSpec[],
  userCaches?: CacheSpec[]
): CacheSpec[] | undefined {
  if (!kitCaches && !userCaches) {
    return undefined
  }

  const map = new Map<string, CacheSpec>()
  for (const c of kitCaches ?? []) {
    map.set(c.name, c)
  }

  for (const c of userCaches ?? []) {
    map.set(c.name, c)
  }

  return [...map.values()]
}

export function mergeMounts(
  kitMounts?: MountSpec[],
  userMounts?: MountSpec[]
): MountSpec[] | undefined {
  if (!kitMounts && !userMounts) {
    return undefined
  }

  return [...(kitMounts ?? []), ...(userMounts ?? [])]
}

export function mergeSetup(
  kitSetup?: SetupSpec,
  userSetup?: SetupSpec
): SetupSpec | undefined {
  if (!kitSetup && !userSetup) {
    return undefined
  }

  if (!kitSetup) {
    return userSetup
  }

  if (!userSetup) {
    return kitSetup
  }

  return {
    cmd: userSetup.cmd,
    caches: mergeCaches(kitSetup.caches, userSetup.caches),
    allowNetwork: userSetup.allowNetwork ?? kitSetup.allowNetwork
  }
}
