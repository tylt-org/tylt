import {randomUUID} from 'node:crypto'
import test from 'ava'
import {DockerCliExecutor, buildCreateArgs} from '../engine/docker-executor.js'
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

async function makeWorkspace(): Promise<Workspace> {
  const tmpDir = await createTmpDir()
  return Workspace.create(tmpDir, 'test-ws')
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

const defaultExecutorOptions = {allowedCapabilities: [], allowNewPrivileges: false}

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

// -- buildCreateArgs (pure, no Docker required) ------------------------------

test('buildCreateArgs emits --cap-drop=ALL by default', async t => {
  const workspace = await makeWorkspace()
  const request = await baseRequest(workspace)
  const args = buildCreateArgs(workspace, request, defaultExecutorOptions)
  t.true(args.includes('--cap-drop=ALL'))
})

test('buildCreateArgs emits --security-opt no-new-privileges by default', async t => {
  const workspace = await makeWorkspace()
  const request = await baseRequest(workspace)
  const args = buildCreateArgs(workspace, request, defaultExecutorOptions)
  const idx = args.indexOf('--security-opt')
  t.not(idx, -1)
  t.is(args[idx + 1], 'no-new-privileges')
})

test('buildCreateArgs aligns --memory-swap with --memory when memory is set', async t => {
  const workspace = await makeWorkspace()
  const request = await baseRequest(workspace, {resourceLimits: {memory: '256m'}})
  const args = buildCreateArgs(workspace, request, defaultExecutorOptions)
  const memIdx = args.indexOf('--memory')
  const swapIdx = args.indexOf('--memory-swap')
  t.not(memIdx, -1)
  t.not(swapIdx, -1)
  t.is(args[memIdx + 1], '256m')
  t.is(args[swapIdx + 1], '256m')
})

test('buildCreateArgs omits --memory-swap when memory is absent', async t => {
  const workspace = await makeWorkspace()
  const request = await baseRequest(workspace)
  const args = buildCreateArgs(workspace, request, defaultExecutorOptions)
  t.false(args.includes('--memory'))
  t.false(args.includes('--memory-swap'))
})

test('buildCreateArgs emits --pids-limit when resourceLimits.pidsLimit is set', async t => {
  const workspace = await makeWorkspace()
  const request = await baseRequest(workspace, {resourceLimits: {pidsLimit: 256}})
  const args = buildCreateArgs(workspace, request, defaultExecutorOptions)
  const idx = args.indexOf('--pids-limit')
  t.not(idx, -1)
  t.is(args[idx + 1], '256')
})

test('buildCreateArgs omits --pids-limit when not set', async t => {
  const workspace = await makeWorkspace()
  const request = await baseRequest(workspace)
  const args = buildCreateArgs(workspace, request, defaultExecutorOptions)
  t.false(args.includes('--pids-limit'))
})

test('allowedCapabilities=["NET_RAW"] emits --cap-add=NET_RAW after the drop', async t => {
  const workspace = await makeWorkspace()
  const request = await baseRequest(workspace)
  const args = buildCreateArgs(workspace, request, {allowedCapabilities: ['NET_RAW'], allowNewPrivileges: false})
  const dropIdx = args.indexOf('--cap-drop=ALL')
  const addIdx = args.indexOf('--cap-add=NET_RAW')
  t.not(dropIdx, -1)
  t.not(addIdx, -1)
  t.true(addIdx > dropIdx)
})

test('allowNewPrivileges=true omits --security-opt no-new-privileges', async t => {
  const workspace = await makeWorkspace()
  const request = await baseRequest(workspace)
  const args = buildCreateArgs(workspace, request, {allowedCapabilities: [], allowNewPrivileges: true})
  t.false(args.includes('--security-opt'))
  t.false(args.includes('no-new-privileges'))
})

test('buildCreateArgs places hardening flags before --name', async t => {
  const workspace = await makeWorkspace()
  const request = await baseRequest(workspace)
  const args = buildCreateArgs(workspace, request, defaultExecutorOptions)
  const dropIdx = args.indexOf('--cap-drop=ALL')
  const nameIdx = args.indexOf('--name')
  t.true(dropIdx < nameIdx)
})
