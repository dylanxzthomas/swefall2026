import test from 'node:test'
import assert from 'node:assert/strict'
import { armVoiceWatchdog, closeBounded, within, VoiceDeadline } from './voiceLifecycle.mjs'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
test('a stalled exchange rejects at its outer deadline', async () => {
  await assert.rejects(within(() => new Promise(() => {}), 20, 'exchange_timeout'), error => error instanceof VoiceDeadline && error.category === 'exchange_timeout')
})
test('a watchdog stops the owner call while the exchange promise remains unresolved', async () => {
  let stopped = false, killed = false
  const guard = armVoiceWatchdog({ afterMs: 10, stop: async () => { stopped = true }, killBrowser: () => { killed = true }, teardownMs: 40 })
  await wait(25); assert.equal(stopped, true); assert.equal(killed, false)
  guard.dispose(); await wait(40); assert.equal(killed, false)
})
test('a hanging owner-stop transport cannot prevent browser termination', async () => {
  let killed = false; const reports = []
  const guard = armVoiceWatchdog({ afterMs: 5, stop: () => new Promise(() => {}), killBrowser: () => { killed = true }, report: value => reports.push(value), stopMs: 10, teardownMs: 25 })
  await wait(50); assert.equal(killed, true); assert.deepEqual(reports, ['stop_failed', 'browser_killed']); guard.dispose()
})
test('disposing a completed check prevents late stop and kill callbacks', async () => {
  let calls = 0
  const guard = armVoiceWatchdog({ afterMs: 10, stop: async () => { calls++ }, killBrowser: () => { calls++ }, teardownMs: 10 })
  guard.dispose(); await wait(35); assert.equal(calls, 0)
})
test('stalled audio/browser teardown uses forced process closure', async () => {
  let forced = false
  assert.equal(await closeBounded(() => new Promise(() => {}), () => { forced = true }, 15), false)
  assert.equal(forced, true)
})
