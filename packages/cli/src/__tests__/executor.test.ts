import {Buffer} from 'node:buffer'
import process from 'node:process'
import test from 'ava'
import {resolveExecutor} from '../executor.js'
import {DockerCliExecutor} from '@tylt/core'

test('resolveExecutor without TYLT_EXECUTOR returns DockerCliExecutor', async t => {
  delete process.env.TYLT_EXECUTOR
  const executor = await resolveExecutor()
  t.true(executor instanceof DockerCliExecutor)
})

test('resolveExecutor with TYLT_EXECUTOR loads custom module', async t => {
  const moduleCode = `
    export default class MockExecutor {
      async check() {}
      async run() { return { exitCode: 0, startedAt: new Date(), finishedAt: new Date() } }
      async cleanupContainers() {}
      async killRunningContainers() {}
    }
  `
  const dataUrl = `data:text/javascript;base64,${Buffer.from(moduleCode).toString('base64')}`

  process.env.TYLT_EXECUTOR = dataUrl
  try {
    const executor = await resolveExecutor()
    t.false(executor instanceof DockerCliExecutor)
    t.is(typeof executor.check, 'function')
    t.is(typeof executor.run, 'function')
    t.is(typeof executor.cleanupContainers, 'function')
    t.is(typeof executor.killRunningContainers, 'function')
  } finally {
    delete process.env.TYLT_EXECUTOR
  }
})
