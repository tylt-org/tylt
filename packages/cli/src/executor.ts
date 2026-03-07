import process from 'node:process'
import {DockerCliExecutor, type ContainerExecutor} from '@tylt/core'

export async function resolveExecutor(): Promise<ContainerExecutor> {
  const executorModule = process.env.TYLT_EXECUTOR
  if (!executorModule) {
    return new DockerCliExecutor()
  }

  const mod = await import(executorModule) as {default: new () => ContainerExecutor}
  const ExecutorClass = mod.default
  return new ExecutorClass()
}
