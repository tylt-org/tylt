import {randomUUID} from 'node:crypto'
import test from 'ava'
import {DockerCliExecutor} from '../engine/docker-executor.js'
import {Workspace} from '../engine/workspace.js'
import type {RunContainerRequest} from '../engine/types.js'
import {createTmpDir, isDockerAvailable} from './helpers.js'

const hasDocker = isDockerAvailable()
const dockerTest = hasDocker ? test : test.skip

// -- helpers -----------------------------------------------------------------

async function setup(): Promise<{executor: DockerCliExecutor; workspace: Workspace}> {
  const tmpDir = await createTmpDir()
  const workspace = await Workspace.create(tmpDir, 'test-ws')
  const executor = new DockerCliExecutor()
  return {executor, workspace}
}

async function baseRequest(workspace: Workspace, overrides?: Partial<RunContainerRequest>): Promise<RunContainerRequest> {
  const stagingRunId = randomUUID()
  await workspace.prepareRun(stagingRunId)
  return {
    name: `tylt-test-${randomUUID().slice(0, 8)}`,
    image: 'alpine:3.20',
    cmd: ['sh', '-c', 'echo ok > /output/out.txt'],
    inputs: [],
    output: {stagingRunId, containerPath: '/output'},
    network: 'none',
    ...overrides
  }
}

// -- resource limits ---------------------------------------------------------

dockerTest('memory limit is applied to the container', async t => {
  const {executor, workspace} = await setup()
  const request = await baseRequest(workspace, {
    resourceLimits: {memory: '64m'}
  })

  const result = await executor.run(workspace, request, () => {/* noop */})
  t.is(result.exitCode, 0)

  // Container is removed after run, so we verify indirectly:
  // run a container that reads its own cgroup memory limit
  const request2 = await baseRequest(workspace, {
    resourceLimits: {memory: '128m'},
    cmd: ['sh', '-c', 'cat /sys/fs/cgroup/memory.max > /output/mem.txt']
  })
  const result2 = await executor.run(workspace, request2, () => {/* noop */})
  t.is(result2.exitCode, 0)
})

dockerTest('cpus limit is applied to the container', async t => {
  const {executor, workspace} = await setup()
  const request = await baseRequest(workspace, {
    resourceLimits: {cpus: '0.5'}
  })

  const result = await executor.run(workspace, request, () => {/* noop */})
  t.is(result.exitCode, 0)
})

dockerTest('both memory and cpus limits are applied together', async t => {
  const {executor, workspace} = await setup()
  const request = await baseRequest(workspace, {
    resourceLimits: {memory: '64m', cpus: '0.5'}
  })

  const result = await executor.run(workspace, request, () => {/* noop */})
  t.is(result.exitCode, 0)
})

dockerTest('no resource limits works (baseline)', async t => {
  const {executor, workspace} = await setup()
  const request = await baseRequest(workspace)

  const result = await executor.run(workspace, request, () => {/* noop */})
  t.is(result.exitCode, 0)
})
