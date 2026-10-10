import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { VERSION } from '../index.js'

/*
 * What the package promises about itself, rather than what the client does.
 *
 * Each of these fails silently for whoever hits it: a `files` list missing the types is a
 * package that installs without them, an `engines` floor that CI never runs is a promise
 * nobody checks, and a User-Agent that disagrees with the manifest misreports every call.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))

test('what gets published is the client, its types, the README and the licence', () => {
  assert.deepEqual([...manifest.files].sort(), ['LICENSE', 'README.md', 'index.d.ts', 'index.js'])
})

test('the types are declared in both places a tool might look', () => {
  assert.equal(manifest.types, 'index.d.ts')
  assert.equal(manifest.exports['.'].types, './index.d.ts')
  assert.ok(existsSync(resolve(ROOT, 'index.d.ts')))
})

test('it declares no dependencies', () => {
  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.sideEffects, false)
})

test('the node floor is a version the CI actually runs', () => {
  const floor = manifest.engines.node.match(/(\d+)/)[1]
  const workflow = readFileSync(resolve(ROOT, '.github/workflows/tests.yml'), 'utf8')
  const tested = [...workflow.matchAll(/'(\d+)'/g)].map((m) => Number(m[1])).sort((a, b) => a - b)

  assert.equal(Number(floor), tested[0], 'engines and the CI matrix disagree')
  // `verifyWebhook` reaches `globalThis.crypto.subtle`, global without a flag from Node 19.
  assert.ok(Number(floor) >= 20)
})

test('it is published publicly', () => {
  assert.equal(manifest.publishConfig.access, 'public')
})

test('the version is the same everywhere it is written', () => {
  assert.equal(VERSION, manifest.version)
})

test('a release is a tag without a v', () => {
  const workflow = readFileSync(resolve(ROOT, '.github/workflows/publish.yml'), 'utf8')

  assert.match(workflow, /tags: \['\[0-9\]\*\.\[0-9\]\*\.\[0-9\]\*'\]/)
})

test('the README shows the banner by absolute url', () => {
  // npm rewrites a relative image against the repository and PyPI does not; the absolute
  // URL is the one form that works on every page this README appears on.
  assert.match(
    readFileSync(resolve(ROOT, 'README.md'), 'utf8'),
    /^!\[Translatorio JavaScript SDK\]\(https:\/\/raw\.githubusercontent\.com\/translatorio\/js-sdk\/main\/art\/banner\.png\)/,
  )
})
