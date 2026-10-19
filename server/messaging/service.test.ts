import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MessagingService } from './service.js'
import type { Workflow } from './workflow.js'

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wren-messaging-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, 'test.sqlite')
}

test('duplicate delivery runs once and survives restart; conflicting payload is rejected', async t => {
  const filename = fixture(t)
  let calls = 0
  const workflow: Workflow = { id: 'test', purpose: 'test', async handle() { calls++; return 'Received' } }
  let service = new MessagingService(filename, workflow)
  const input = { externalId: 'one', sender: 'alice', text: 'Hello' }
  const accepted = service.receive(input)
  service.close() // queued work survives shutdown
  service = new MessagingService(filename, workflow)
  try {
    await Promise.all([service.drain(), service.drain()])
    assert.equal(service.receive(input).duplicate, true)
    await service.drain()
    assert.equal(calls, 1)
    assert.equal(service.result(accepted.id)?.reply, 'Received')
    assert.throws(() => service.receive({ ...input, sender: 'bob' }), /different payload/)
    assert.throws(() => service.receive({ ...input, text: 'Changed' }), /different payload/)
  } finally { service.close() }
})

test('history stays ordered and isolated by sender and workflow', async t => {
  const filename = fixture(t)
  const seen: string[][] = []
  const workflow: Workflow = { id: 'test', purpose: 'test', async handle({ history, message }) {
    seen.push(history.map(turn => turn.text)); return `Reply: ${message}`
  } }
  const service = new MessagingService(filename, workflow)
  try {
    for (const [externalId, sender, text] of [['1', 'alice', 'First'], ['2', 'bob', 'Private'], ['3', 'alice', 'Second']]) {
      service.receive({ externalId, sender, text })
    }
    await service.drain()
    assert.deepEqual(seen, [[], [], ['First', 'Reply: First']])
  } finally { service.close() }
  const other = new MessagingService(filename, { ...workflow, id: 'another' })
  try {
    other.receive({ externalId: '4', sender: 'alice', text: 'New workflow' })
    await other.drain()
    assert.deepEqual(seen.at(-1), [])
  } finally { other.close() }
})

test('failure blocks that conversation without blocking other senders', async t => {
  const service = new MessagingService(fixture(t), { id: 'test', purpose: 'test', async handle({ message }) {
    if (message === 'Fail') throw new Error('Temporary failure')
    return 'OK'
  } })
  try {
    const first = service.receive({ externalId: '1', sender: 'alice', text: 'Fail' })
    const second = service.receive({ externalId: '2', sender: 'alice', text: 'Later' })
    const other = service.receive({ externalId: '3', sender: 'bob', text: 'Hello' })
    await service.drain()
    assert.equal(service.result(first.id)?.state, 'failed')
    assert.equal(service.result(second.id)?.state, 'queued')
    assert.equal(service.result(other.id)?.state, 'completed')
    assert.throws(() => service.receive({ externalId: '4', sender: 'bob', text: '  ' }))
  } finally { service.close() }
})
