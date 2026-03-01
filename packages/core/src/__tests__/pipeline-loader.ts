import test from 'ava'
import {CyclicDependencyError, ValidationError} from '../errors.js'
import type {Kit, KitContext} from '../types.js'
import {
  PipelineLoader,
  slugify,
  parsePipelineFile,
  mergeEnv,
  mergeCaches,
  mergeMounts,
  mergeSetup
} from '../pipeline-loader.js'

const fakeShellKit: Kit = {
  name: 'shell',
  resolve(params) {
    const run = params.run as string
    return {image: 'alpine:3.20', cmd: ['sh', '-c', run]}
  }
}

const kits = new Map<string, Kit>([['shell', fakeShellKit]])
const fakeKitContext: KitContext = {config: {}, cwd: '/tmp', kits}

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

test('slugify converts accented characters', t => {
  t.is(slugify('Étape numéro un'), 'etape-numero-un')
})

test('slugify strips diacritics from various scripts', t => {
  t.is(slugify('crème brûlée'), 'creme-brulee')
  t.is(slugify('Ñoño'), 'nono')
  t.is(slugify('Ångström'), 'angstrom')
  t.is(slugify('Dženán'), 'dzenan')
  t.is(slugify('naïve café'), 'naive-cafe')
})

test('slugify replaces spaces with hyphens', t => {
  t.is(slugify('hello world'), 'hello-world')
})

test('slugify replaces special characters', t => {
  t.is(slugify('build@v2!'), 'build-v2')
  t.is(slugify('build@v2!final'), 'build-v2-final')
})

test('slugify collapses double hyphens', t => {
  t.is(slugify('a--b'), 'a-b')
})

test('slugify strips leading and trailing hyphens', t => {
  t.is(slugify('-hello-'), 'hello')
})

// ---------------------------------------------------------------------------
// parsePipelineFile
// ---------------------------------------------------------------------------

test('parsePipelineFile parses valid JSON', t => {
  const result = parsePipelineFile('{"id": "test"}', 'pipeline.json') as {id: string}
  t.is(result.id, 'test')
})

test('parsePipelineFile parses YAML for .yaml extension', t => {
  const result = parsePipelineFile('id: test', 'pipeline.yaml') as {id: string}
  t.is(result.id, 'test')
})

test('parsePipelineFile parses YAML for .yml extension', t => {
  const result = parsePipelineFile('id: test', 'pipeline.yml') as {id: string}
  t.is(result.id, 'test')
})

test('parsePipelineFile throws on invalid JSON', t => {
  t.throws(() => parsePipelineFile('{invalid', 'pipeline.json'))
})

// ---------------------------------------------------------------------------
// mergeEnv
// ---------------------------------------------------------------------------

test('mergeEnv returns undefined when both are undefined', t => {
  t.is(mergeEnv(undefined, undefined), undefined)
})

test('mergeEnv returns kit env when user is undefined', t => {
  t.deepEqual(mergeEnv({A: '1'}, undefined), {A: '1'})
})

test('mergeEnv returns user env when kit is undefined', t => {
  t.deepEqual(mergeEnv(undefined, {B: '2'}), {B: '2'})
})

test('mergeEnv user overrides kit', t => {
  t.deepEqual(mergeEnv({A: '1'}, {A: '2'}), {A: '2'})
})

test('mergeEnv merges both', t => {
  t.deepEqual(mergeEnv({A: '1'}, {B: '2'}), {A: '1', B: '2'})
})

// ---------------------------------------------------------------------------
// mergeCaches
// ---------------------------------------------------------------------------

test('mergeCaches returns undefined when both are undefined', t => {
  t.is(mergeCaches(undefined, undefined), undefined)
})

test('mergeCaches concatenates non-overlapping caches', t => {
  const result = mergeCaches(
    [{name: 'a', path: '/a'}],
    [{name: 'b', path: '/b'}]
  )
  t.deepEqual(result, [
    {name: 'a', path: '/a'},
    {name: 'b', path: '/b'}
  ])
})

test('mergeCaches user wins on same name', t => {
  const result = mergeCaches(
    [{name: 'x', path: '/kit'}],
    [{name: 'x', path: '/user'}]
  )
  t.deepEqual(result, [{name: 'x', path: '/user'}])
})

// ---------------------------------------------------------------------------
// mergeMounts
// ---------------------------------------------------------------------------

test('mergeMounts returns undefined when both are undefined', t => {
  t.is(mergeMounts(undefined, undefined), undefined)
})

test('mergeMounts concatenates mounts', t => {
  const result = mergeMounts(
    [{host: 'a', container: '/a'}],
    [{host: 'b', container: '/b'}]
  )
  t.deepEqual(result, [
    {host: 'a', container: '/a'},
    {host: 'b', container: '/b'}
  ])
})

// ---------------------------------------------------------------------------
// PipelineLoader.parse
// ---------------------------------------------------------------------------

const loader = new PipelineLoader()

test('parse: valid pipeline with raw steps', async t => {
  const pipeline = await loader.parse(JSON.stringify({
    id: 'my-pipeline',
    steps: [{
      id: 'step1',
      image: 'alpine',
      cmd: ['echo', 'hello']
    }]
  }), 'p.json')

  t.is(pipeline.id, 'my-pipeline')
  t.is(pipeline.steps.length, 1)
  t.is(pipeline.steps[0].id, 'step1')
})

test('parse: derives id from name via slugify', async t => {
  const pipeline = await loader.parse(JSON.stringify({
    name: 'Mon Pipeline',
    steps: [{
      name: 'Première Étape',
      image: 'alpine',
      cmd: ['echo']
    }]
  }), 'p.json')

  t.is(pipeline.id, 'mon-pipeline')
  t.is(pipeline.steps[0].id, 'premiere-etape')
})

test('parse: throws ValidationError when neither id nor name on pipeline', async t => {
  const error = await t.throwsAsync(async () => loader.parse(JSON.stringify({
    steps: [{id: 's', image: 'alpine', cmd: ['echo']}]
  }), 'p.json'), {message: /at least one of "id" or "name"/})
  t.true(error instanceof ValidationError)
})

test('parse: throws ValidationError when neither id nor name on step', async t => {
  const error = await t.throwsAsync(async () => loader.parse(JSON.stringify({
    id: 'p',
    steps: [{image: 'alpine', cmd: ['echo']}]
  }), 'p.json'), {message: /at least one of "id" or "name"/})
  t.true(error instanceof ValidationError)
})

test('parse: throws ValidationError on empty steps array', async t => {
  const error = await t.throwsAsync(async () => loader.parse(JSON.stringify({
    id: 'p', steps: []
  }), 'p.json'), {message: /steps must be a non-empty array/})
  t.true(error instanceof ValidationError)
})

test('parse: throws on invalid identifier with path traversal', async t => {
  await t.throwsAsync(async () => loader.parse(JSON.stringify({
    id: 'p',
    steps: [{id: '../bad', image: 'alpine', cmd: ['echo']}]
  }), 'p.json'), {message: /must contain only alphanumeric/})
})

test('parse: throws on invalid identifier with special chars', async t => {
  await t.throwsAsync(async () => loader.parse(JSON.stringify({
    id: 'p',
    steps: [{id: 'hello world', image: 'alpine', cmd: ['echo']}]
  }), 'p.json'), {message: /must contain only alphanumeric/})
})

test('parse: throws when step has no image', async t => {
  await t.throwsAsync(async () => loader.parse(JSON.stringify({
    id: 'p',
    steps: [{id: 's', cmd: ['echo']}]
  }), 'p.json'), {message: /image is required/})
})

test('parse: throws when step has no cmd', async t => {
  await t.throwsAsync(async () => loader.parse(JSON.stringify({
    id: 'p',
    steps: [{id: 's', image: 'alpine'}]
  }), 'p.json'), {message: /cmd must be a non-empty array/})
})

test('parse: throws ValidationError on duplicate step ids', async t => {
  const error = await t.throwsAsync(async () => loader.parse(JSON.stringify({
    id: 'p',
    steps: [
      {id: 's', image: 'alpine', cmd: ['echo']},
      {id: 's', image: 'alpine', cmd: ['echo']}
    ]
  }), 'p.json'), {message: /Duplicate step id/})
  t.true(error instanceof ValidationError)
})

test('parse: validates mount host must be relative', async t => {
  await t.throwsAsync(async () => loader.parse(JSON.stringify({
    id: 'p',
    steps: [{
      id: 's', image: 'alpine', cmd: ['echo'],
      mounts: [{host: '/absolute', container: '/c'}]
    }]
  }), 'p.json'), {message: /must be a relative path/})
})

test('parse: allows mount host with ..', async t => {
  await t.notThrowsAsync(async () => loader.parse(JSON.stringify({
    id: 'p',
    steps: [{
      id: 's', image: 'alpine', cmd: ['echo'],
      mounts: [{host: '../sibling', container: '/c'}]
    }]
  }), 'p.json'))
})

test('parse: validates mount container must be absolute', async t => {
  await t.throwsAsync(async () => loader.parse(JSON.stringify({
    id: 'p',
    steps: [{
      id: 's', image: 'alpine', cmd: ['echo'],
      mounts: [{host: 'src', container: 'relative'}]
    }]
  }), 'p.json'), {message: /must be an absolute path/})
})

test('parse: validates cache path must be absolute', async t => {
  await t.throwsAsync(async () => loader.parse(JSON.stringify({
    id: 'p',
    steps: [{
      id: 's', image: 'alpine', cmd: ['echo'],
      caches: [{name: 'c', path: 'relative'}]
    }]
  }), 'p.json'), {message: /must be an absolute path/})
})

test('parse: validates cache name is a valid identifier', async t => {
  await t.throwsAsync(async () => loader.parse(JSON.stringify({
    id: 'p',
    steps: [{
      id: 's', image: 'alpine', cmd: ['echo'],
      caches: [{name: 'bad name!', path: '/cache'}]
    }]
  }), 'p.json'), {message: /must contain only alphanumeric/})
})

test('parse: resolves kit step (uses → image/cmd)', async t => {
  const kitLoader = new PipelineLoader(fakeKitContext)
  const pipeline = await kitLoader.parse(JSON.stringify({
    id: 'p',
    steps: [{
      id: 'b',
      uses: 'shell',
      with: {run: 'echo hello'}
    }]
  }), 'p.json')

  t.is(pipeline.steps[0].image, 'alpine:3.20')
  t.deepEqual(pipeline.steps[0].cmd, ['sh', '-c', 'echo hello'])
})

// ---------------------------------------------------------------------------
// DAG validation
// ---------------------------------------------------------------------------

test('parse: detects cycle → CyclicDependencyError', async t => {
  const error = await t.throwsAsync(async () => loader.parse(JSON.stringify({
    id: 'p',
    steps: [
      {id: 'a', image: 'alpine', cmd: ['echo'], inputs: [{step: 'b'}]},
      {id: 'b', image: 'alpine', cmd: ['echo'], inputs: [{step: 'a'}]}
    ]
  }), 'p.json'), {message: /cycle/})
  t.true(error instanceof CyclicDependencyError)
})

test('parse: missing input ref → error', async t => {
  await t.throwsAsync(async () => loader.parse(JSON.stringify({
    id: 'p',
    steps: [
      {id: 'a', image: 'alpine', cmd: ['echo'], inputs: [{step: 'missing'}]}
    ]
  }), 'p.json'), {message: /unknown step 'missing'/})
})

test('parse: optional input to unknown step → OK', async t => {
  await t.notThrowsAsync(async () => loader.parse(JSON.stringify({
    id: 'p',
    steps: [
      {id: 'a', image: 'alpine', cmd: ['echo'], inputs: [{step: 'missing', optional: true}]}
    ]
  }), 'p.json'))
})

test('parse: valid DAG diamond → OK', async t => {
  await t.notThrowsAsync(async () => loader.parse(JSON.stringify({
    id: 'p',
    steps: [
      {id: 'a', image: 'alpine', cmd: ['echo']},
      {id: 'b', image: 'alpine', cmd: ['echo'], inputs: [{step: 'a'}]},
      {id: 'c', image: 'alpine', cmd: ['echo'], inputs: [{step: 'a'}]},
      {id: 'd', image: 'alpine', cmd: ['echo'], inputs: [{step: 'b'}, {step: 'c'}]}
    ]
  }), 'p.json'))
})

// ---------------------------------------------------------------------------
// mergeSetup
// ---------------------------------------------------------------------------

test('mergeSetup returns undefined when both are undefined', t => {
  t.is(mergeSetup(undefined, undefined), undefined)
})

test('mergeSetup returns kit setup when user is undefined', t => {
  const kit = {cmd: ['sh', '-c', 'install'], allowNetwork: true}
  t.deepEqual(mergeSetup(kit, undefined), kit)
})

test('mergeSetup returns user setup when kit is undefined', t => {
  const user = {cmd: ['sh', '-c', 'my-install'], allowNetwork: false}
  t.deepEqual(mergeSetup(undefined, user), user)
})

test('mergeSetup user cmd overrides kit cmd', t => {
  const kit = {cmd: ['sh', '-c', 'kit-install'], caches: [{name: 'c', path: '/c'}]}
  const user = {cmd: ['sh', '-c', 'user-install']}
  const result = mergeSetup(kit, user)!
  t.deepEqual(result.cmd, ['sh', '-c', 'user-install'])
})

test('mergeSetup merges caches (user wins by name)', t => {
  const kit = {cmd: ['sh', '-c', 'a'], caches: [{name: 'x', path: '/kit'}]}
  const user = {cmd: ['sh', '-c', 'b'], caches: [{name: 'x', path: '/user'}]}
  const result = mergeSetup(kit, user)!
  t.deepEqual(result.caches, [{name: 'x', path: '/user'}])
})

test('mergeSetup user allowNetwork overrides kit', t => {
  const kit = {cmd: ['sh', '-c', 'a'], allowNetwork: true}
  const user = {cmd: ['sh', '-c', 'b'], allowNetwork: false}
  const result = mergeSetup(kit, user)!
  t.false(result.allowNetwork)
})

test('mergeSetup falls back to kit allowNetwork when user omits it', t => {
  const kit = {cmd: ['sh', '-c', 'a'], allowNetwork: true}
  const user = {cmd: ['sh', '-c', 'b']}
  const result = mergeSetup(kit, user)!
  t.true(result.allowNetwork)
})

// ---------------------------------------------------------------------------
// Setup validation
// ---------------------------------------------------------------------------

test('parse: step with valid setup passes validation', async t => {
  await t.notThrowsAsync(async () => loader.parse(JSON.stringify({
    id: 'p',
    steps: [{
      id: 's', image: 'alpine', cmd: ['echo'],
      setup: {cmd: ['sh', '-c', 'install'], caches: [{name: 'apt', path: '/var/cache/apt'}]}
    }]
  }), 'p.json'))
})

test('parse: setup with empty cmd throws ValidationError', async t => {
  await t.throwsAsync(async () => loader.parse(JSON.stringify({
    id: 'p',
    steps: [{
      id: 's', image: 'alpine', cmd: ['echo'],
      setup: {cmd: []}
    }]
  }), 'p.json'), {message: /setup\.cmd must be a non-empty array/})
})

test('parse: setup with invalid cache name throws ValidationError', async t => {
  await t.throwsAsync(async () => loader.parse(JSON.stringify({
    id: 'p',
    steps: [{
      id: 's', image: 'alpine', cmd: ['echo'],
      setup: {cmd: ['sh'], caches: [{name: 'bad name!', path: '/cache'}]}
    }]
  }), 'p.json'), {message: /must contain only alphanumeric/})
})

test('parse: setup with relative cache path throws ValidationError', async t => {
  await t.throwsAsync(async () => loader.parse(JSON.stringify({
    id: 'p',
    steps: [{
      id: 's', image: 'alpine', cmd: ['echo'],
      setup: {cmd: ['sh'], caches: [{name: 'c', path: 'relative'}]}
    }]
  }), 'p.json'), {message: /must be an absolute path/})
})
