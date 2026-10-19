import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sourceVersion } from './release-metadata.mjs'
const metadata = { version: 1, commit: 'a'.repeat(40), dirty: true, sourceSha256: 'b'.repeat(64), evaluatedModel: 'claude-sonnet-5-5' }
test('retains reviewed uncommitted source identity and the explicitly evaluated model', () => {
  assert.deepEqual(sourceVersion(metadata), metadata)
  assert.equal(sourceVersion({ ...metadata, commit: null, evaluatedModel: null }).commit, null)
})
test('rejects arbitrary extra metadata without reflecting private values', () => {
  const secret = 'synthetic-private-credential'
  assert.throws(() => sourceVersion({ ...metadata, credential: secret }), error => !error.message.includes(secret))
})
test('rejects malformed commit, snapshot, model and clean-state claims', () => {
  for (const value of [{ ...metadata, commit: 'main' }, { ...metadata, commit: [metadata.commit] }, { ...metadata, sourceSha256: [metadata.sourceSha256] }, { ...metadata, sourceSha256: 'missing' }, { ...metadata, dirty: 'false' }, { ...metadata, evaluatedModel: 'unknown/key' }, null]) assert.throws(() => sourceVersion(value))
})
