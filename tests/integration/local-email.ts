import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
// Privileged fixture imports are only allowed into the preserved anonymous local runtime.
assert.match(readFileSync('.env.local', 'utf8'), /^CONVEX_DEPLOYMENT=anonymous:/m)
const cli = (...args: string[]) => {
  const result = spawnSync(process.execPath, ['node_modules/convex/bin/main.js', ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr.replace(/https:\/\/dashboard[^\s]+/g, '[local dashboard]'))
  return result.stdout.trim()
}
const configured = cli('env', 'list')
assert.ok(!configured.includes('ANTHROPIC_API_KEY') && !configured.includes('DAYMARK_MODEL'), 'This synthetic suite refuses a model-configured deployment.')
const suffix = Date.now(), subject = `synthetic-email-${suffix}`, outsider = `synthetic-email-outsider-${suffix}`
const identity = (user: string) => JSON.stringify({ subject: user, issuer: 'https://daymark-test.invalid', tokenIdentifier: `https://daymark-test.invalid|${user}`, email: 'parent@example.test', emailVerified: true })
const run = (fn: string, input: unknown, user?: string) => {
  const out = cli('run', fn, JSON.stringify(input), ...(user ? ['--identity', identity(user)] : []))
  return out ? JSON.parse(out) : undefined
}
const read = (expression: string) => JSON.parse(cli('run', '--inline-query', expression))
const scratch = mkdtempSync(join(tmpdir(), 'daymark-email-'))
const append = (table: string, record: unknown) => {
  const path = join(scratch, `${table}.json`); writeFileSync(path, JSON.stringify([record]), { mode: 0o600 })
  cli('import', '--append', '--table', table, path)
}
const householdId = run('households:save', { timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }] }, subject)
const otherHouseholdId = run('households:save', { timezone: 'UTC', children: [] }, outsider)
try {
  append('connections', { householdId, subject: `https://daymark-test.invalid|${subject}`, provider: 'google', version: 1, status: 'active', scopes: ['https://www.googleapis.com/auth/gmail.readonly'], email: 'synthetic@example.test' })
  const connectionId = run('connections:overview', {}, subject).items[0].id
  const now = Date.now(), requestId = `synthetic-watch-${suffix}`
  append('emailWatches', { householdId, createdBy: `https://daymark-test.invalid|${subject}`, requestId, requestHash: 'synthetic-fixture', connectionId, connectionVersion: 1, version: 1, title: 'Synthetic local email proof', senders: ['school@example.test'], instruction: 'Prepare useful follow-ups for review.', state: 'active', consentedAt: now, createdAt: now, nextCheckAt: now + 86400000, windowFrom: now - 86400000, windowThrough: now, lease: 'synthetic-fixture', leaseUntil: now + 120000 })
  const watchId = run('emailWatches:list', {}, subject)[0].id
  const lease = { id: watchId, version: 1, lease: 'synthetic-fixture' }
  const message = { id: `synthetic-message-${suffix}`, threadId: 'synthetic-thread', sender: 'school@example.test', subject: 'Synthetic trip form', receivedAt: now - 1000, text: 'Please return Maya’s signed form by October 20.', truncated: false, extraction: { format: 'plain', truncated: false, incomplete: false, attachments: false, issues: [] } }
  assert.equal(run('emailWatches:finish', { ...lease, messages: [message, message] }), true)
  assert.equal(run('emailWatches:finish', { ...lease, messages: [message] }), false)
  let jobs: any[] = []
  for (let n = 0; n < 20; n++) { jobs = run('jobs:list', {}, subject); if (jobs[0] && !jobs[0].preparing) break; await new Promise(resolve => setTimeout(resolve, 500)) }
  assert.equal(jobs.length, 1); assert.equal(jobs[0].preparing, false); assert.match(jobs[0].clarification, /not connected/)
  assert.equal(jobs[0].source.email.subject, message.subject); assert.equal(jobs[0].source.email.receivedAt, message.receivedAt)
  const jobId = jobs[0]._id
  // Fixture preparation is seeded explicitly: no Gmail read, model call, or external action.
  append('emailTaskSuggestions', { householdId, jobId, sourceRevision: 1, version: 1, status: 'proposed', title: 'Return Maya’s form', notes: 'Synthetic responsibility.', dueDate: '2026-10-20', childId: 'maya', evidence: ['Please return Maya’s signed form by October 20.'], semanticKey: 'synthetic-fixture' })
  const suggestion = run('emailFollowups:suggestions', {}, subject)[0]
  assert.equal(suggestion.canSave, true); assert.deepEqual(run('emailFollowups:suggestions', {}, outsider), [])
  const input = { title: 'Sign and return Maya’s form', notes: 'My reviewed edit.', dueDate: '2026-10-19', childId: 'maya' }
  assert.throws(() => run('emailFollowups:saveTask', { id: suggestion.id, version: 1, sourceRevision: 1, input }, outsider), /unavailable/)
  const saved = run('emailFollowups:saveTask', { id: suggestion.id, version: 1, sourceRevision: 1, input }, subject)
  assert.equal(run('emailFollowups:saveTask', { id: suggestion.id, version: 1, sourceRevision: 1, input }, subject), saved)
  assert.deepEqual(run('personalTasks:list', {}, subject).map((t: any) => ({ title: t.title, done: t.done, dueDate: t.dueDate })), [{ title: input.title, done: false, dueDate: input.dueDate }])
  run('emailFollowups:handleMessage', { jobId, sourceRevision: 1, handlingVersion: 0, operation: 'snooze', until: Date.now() + 86400000 }, subject)
  assert.deepEqual(run('jobs:list', {}, subject), [])
  assert.equal(run('emailWatches:recentChecks', {}, subject)[0].status, 'snoozed')
  run('emailFollowups:handleMessage', { jobId, sourceRevision: 1, handlingVersion: 1, operation: 'restore' }, subject)
  assert.equal(run('jobs:list', {}, subject).length, 1)
  assert.throws(() => run('emailFollowups:handleMessage', { jobId, sourceRevision: 1, handlingVersion: 1, operation: 'dismiss' }, subject), /review changed/)
  run('personalTasks:remove', { id: saved, version: 1 }, subject)
  assert.equal(run('emailFollowups:saveTask', { id: suggestion.id, version: 1, sourceRevision: 1, input }, subject), saved)
  assert.deepEqual(run('personalTasks:list', {}, subject), [])
  assert.deepEqual(read(`return await ctx.db.query('approvals').withIndex('by_action_revision').filter(q=>q.eq(q.field('householdId'),${JSON.stringify(householdId)})).collect()`), [])
  run('emailWatches:setPaused', { id: watchId, version: 1, paused: true }, subject)
  assert.throws(() => run('emailFollowups:handleMessage', { jobId, sourceRevision: 1, handlingVersion: 2, operation: 'dismiss' }, subject), /changed or stopped/)
  run('connections:erase', { id: connectionId, version: 1, revoked: true })
  console.log('Local Convex Gmail fixture: persisted provenance, owner isolation, one unfinished edited task, snooze/restore, stale decision rejection, removal retry and paused access passed. No Gmail/model/provider call.')
} finally {
  for (const [user, id] of [[subject, householdId], [outsider, otherHouseholdId]]) {
    run('privacy:deleteAccount', { confirmation: 'DELETE' }, user)
    const deletion = read(`return await ctx.db.query('deletionJobs').filter(q=>q.eq(q.field('householdId'),${JSON.stringify(id)})).first()`)
    if (deletion) run('privacy:eraseHousehold', { householdId: id, jobId: deletion._id })
  }
  rmSync(scratch, { recursive: true, force: true })
}
