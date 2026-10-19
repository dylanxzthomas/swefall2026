import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { ConvexHttpClient } from 'convex/browser'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { api, internal } from '../../convex/_generated/api.js'
import type { Id } from '../../convex/_generated/dataModel.js'
import { sourceHash } from '../../shared/daymark.js'
import { gmailReadScope } from '../../shared/emailWatches.js'
import { attachmentDescriptors } from '../../shared/mailAttachments.js'
import { extractMailAttachment } from '../../convex/gmailAttachments.js'
import { extractStructured } from '../../server/model.js'
import { checkedCoordinatorStep, coordinatorPrompt, coordinatorStep } from '../../shared/assistantCoordinator.js'

// Actual local model and durable schedulers, isolated made-up sources only.
// This script never invokes Gmail, Calendar, external sends or provider writes.
const config = JSON.parse(readFileSync('.convex/local/default/config.json', 'utf8')), origin = 'http://127.0.0.1:3210'
assert.equal(config.ports.cloud, 3210)
assert.equal(await (await fetch(`${origin}/instance_name`)).text(), config.deploymentName)
const environment = { ...process.env, CONVEX_AGENT_MODE: 'anonymous', CONVEX_DEPLOYMENT: `anonymous:${config.deploymentName}` }
for (const name of ['CONVEX_DEPLOY_KEY', 'CONVEX_SELF_HOSTED_URL', 'CONVEX_SELF_HOSTED_ADMIN_KEY']) delete environment[name]
const cli = (args: string[], input?: string) => {
  const result = spawnSync(process.execPath, ['node_modules/convex/bin/main.js', ...args], { env: environment, encoding: 'utf8', timeout: 45000, ...(input === undefined ? {} : { input }) })
  assert.equal(result.status, 0, 'Local fixture command failed; potentially private output withheld.')
  return result.stdout.trim()
}
const names = new Set(cli(['env', 'list', '--names-only']).split(/\r?\n/).map(s => s.trim()))
assert.ok(names.has('ANTHROPIC_API_KEY') && names.has('DAYMARK_MODEL'), 'Configure the model before live synthetic evaluation.')
assert.ok(!names.has('AUTH0_MANAGEMENT_CLIENT_ID') && !names.has('AUTH0_MANAGEMENT_CLIENT_SECRET'), 'Fixture cleanup must not contact Auth0.')
assert.ok(!names.has('DAYMARK_ENVIRONMENT') || cli(['env', 'get', 'DAYMARK_ENVIRONMENT']) !== 'production')
const oldAllowlist = cli(['env', 'get', 'DAYMARK_TEST_GOOGLE_EMAILS']), suffix = randomUUID(), email = `synthetic-${suffix}@example.test`, subject = `synthetic-assistant-${suffix}`, owner = `https://daymark-test.invalid|${subject}`
const scratch = mkdtempSync(join(tmpdir(), 'sola-assistant-')), client = new ConvexHttpClient(origin), admin = new ConvexHttpClient(origin), other = new ConvexHttpClient(origin)
client.setAdminAuth(config.adminKey, { subject, tokenIdentifier: owner, issuer: 'https://daymark-test.invalid', email, emailVerified: true }); admin.setAdminAuth(config.adminKey)
other.setAdminAuth(config.adminKey, { subject: `${subject}-other`, tokenIdentifier: `${owner}-other`, issuer: 'https://daymark-test.invalid' })
const read = (expression: string) => JSON.parse(cli(['run', '--inline-query', expression]))
const append = (table: string, record: unknown) => { const path = join(scratch, `${table}.json`); writeFileSync(path, JSON.stringify([record]), { mode: 0o600 }); cli(['import', '--append', '--table', table, path]) }
const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))
let householdId: Id<'households'> | undefined, allowlistChanged = false, stage = 'configuration'
const priorKey = process.env.ANTHROPIC_API_KEY, priorModel = process.env.DAYMARK_MODEL
const learningOnly = process.argv.includes('--learning-only'), validationOnly = process.argv.includes('--validation-only'), reviewedOnly = process.argv.includes('--reviewed-only'), approvalOnly = process.argv.includes('--approval-only')
async function turn(text: string) {
  const id = await client.mutation(api.jobs.submit, { text }), deadline = Date.now() + 300000
  while (Date.now() < deadline) {
    const job = (await client.query(api.jobs.list, {})).find(j => j._id === id)
    if (job && !job.preparing) {
      assert.equal(job.actions.length, 0, 'Conversation/preparation must not execute provider work.')
      const runs = await client.query(api.assistantCoordinator.list, {}), run = runs.find(r => r.jobId === id)
      if (run?.status !== 'complete') {
        const checkpoint = run ? read(`return await ctx.db.get(${JSON.stringify(run.id)})`) : null
        console.log(`Synthetic turn checkpoint: coordinator=${run?.status ?? 'absent'}, actions=${job.actions.length}, preparing=${job.preparing}, replyCharacters=${job.clarification.length}, step=${checkpoint?.step ?? 0}, attempts=${checkpoint?.attempts ?? 0}, failureCode=${checkpoint?.failureCode ?? 'unrecorded'}, failureStatus=${checkpoint?.failureStatus ?? 'none'}, tools=${(checkpoint?.used ?? []).map((key: string) => JSON.parse(key)[0]).join(',')}.`)
        if (checkpoint && process.argv.includes('--debug-model')) {
          // Reproduce only this isolated fictional input; report no output/error body.
          process.env.ANTHROPIC_API_KEY = cli(['env', 'get', 'ANTHROPIC_API_KEY']); process.env.DAYMARK_MODEL = cli(['env', 'get', 'DAYMARK_MODEL'])
          const assistant = JSON.parse(checkpoint.baseContext ?? 'null')
          try {
            const observations = JSON.parse(checkpoint.observations)
            const privateNoticeBlocked = !!(checkpoint.privateOnly || checkpoint.mailContext || checkpoint.workingContext || checkpoint.contextBindings?.some((b: any) => b.mailContext || b.workingContext) || checkpoint.refs?.some((ref: any) => ['mail', 'calendar', 'attachment'].includes(ref.kind)))
            const result = await extractStructured(coordinatorStep, coordinatorPrompt, { canPrepareNotice: !privateNoticeBlocked, canLearn: !checkpoint.calendarTriggered, trigger: checkpoint.calendarTriggered ? 'calendar' : 'request', source: { sourceId: checkpoint.sourceId, text }, assistant, capabilities: assistant?.capabilities ?? [], observations, used: checkpoint.used, step: checkpoint.step + 1, remainingSteps: 6 - checkpoint.step, now: new Date().toISOString() }, [], undefined, assistant?.history, { maxTokens: 4000, timeoutMs: 60000 })
            let contractFailure = 'none'
            try { checkedCoordinatorStep(result, [{ sourceId: checkpoint.sourceId, text }, ...observations.flatMap((o: any) => o.evidence ?? [])], checkpoint.used) }
            catch (cause) { const message = cause instanceof Error ? cause.message : ''; contractFailure = /arguments|historical window/.test(message) ? 'unsupported_arguments' : /exact evidence/.test(message) ? 'source_evidence' : /different read/.test(message) ? 'repeated_read' : /publish/.test(message) ? 'read_publication' : 'schema_contract' }
            console.log(JSON.stringify({ syntheticModelDiagnostic: true, schemaSuccess: true, tool: result.tool, argumentNames: (['query', 'id', 'from', 'through'] as const).filter(key => result[key]), numericWindow: result.lookbackDays == null ? 'none' : result.lookbackDays === 0 ? 'zero' : 'set', draftCount: result.drafts.length, contractFailure, privateNoticeBlocked }))
          } catch (cause) {
            const diagnostic = cause as { constructor?: { name?: string }; status?: number; issues?: { path?: unknown[] }[] }
            console.log(JSON.stringify({ syntheticModelDiagnostic: true, errorClass: diagnostic.constructor?.name ?? 'UnknownError', status: Number.isInteger(diagnostic.status) ? diagnostic.status : null, lookbackValidation: diagnostic.issues?.some(issue => issue.path?.[0] === 'lookbackDays') ?? false }))
          }
        }
      }
      if (run) assert.equal(run.status, 'complete', 'Coordinator did not complete; private output withheld.')
      if (run && stage === 'reviewed learning' && process.argv.includes('--debug-model')) {
        const checkpoint = read(`return await ctx.db.get(${JSON.stringify(run.id)})`)
        console.log(JSON.stringify({ syntheticLearningCheckpoint: true, step: checkpoint.step, attempts: checkpoint.attempts, tools: checkpoint.used.map((key: string) => JSON.parse(key)[0]), correctionReasons: JSON.parse(checkpoint.observations).filter((o: any) => o.tool === 'validation').map((o: any) => ['arguments','evidence','duplicate','private','steps','format'].includes(o.result?.reason) ? o.result.reason : 'legacy') }))
      }
      return { job, run }
    }
    await wait(500)
  }
  throw new Error('The synthetic conversation did not finish in its bounded wait.')
}
try {
  if (!validationOnly && !reviewedOnly && !approvalOnly) { cli(['env', 'set', 'DAYMARK_TEST_GOOGLE_EMAILS'], `${oldAllowlist},${email}`); allowlistChanged = true }
  householdId = await client.mutation(api.households.save, { timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }] })
  append('memberships', { householdId, subject: `${owner}-other`, role: 'adult' })
  if (approvalOnly) {
    stage = 'email approval without provider dispatch'
    const recipient = 'coordinator@example.test', text = 'Draft a household email for review only.'
    const priorRecipients = names.has('DAYMARK_TEST_EMAIL_RECIPIENTS') ? cli(['env', 'get', 'DAYMARK_TEST_EMAIL_RECIPIENTS']) : undefined
    try {
      cli(['env', 'set', 'DAYMARK_TEST_EMAIL_RECIPIENTS'], [priorRecipients, recipient].filter(Boolean).join(','))
      // Deliberately no encrypted token: no provider request can be dispatched.
      append('connections', { householdId, subject: owner, provider: 'google', status: 'active', version: 1, email, scopes: ['https://www.googleapis.com/auth/gmail.compose'] })
      append('sources', { householdId, text, hash: `approval-${suffix}`, revision: 1, expiresAt: Date.now() + 86400000 })
      const sourceId = read(`return (await ctx.db.query('sources').withIndex('by_hash',q=>q.eq('householdId',${JSON.stringify(householdId)}).eq('hash',${JSON.stringify(`approval-${suffix}`)})).first())._id`)
      append('jobs', { householdId, createdBy: owner, sourceId, preparing: false, cancelled: false, clarification: '' })
      const id = read(`return (await ctx.db.query('jobs').withIndex('by_source',q=>q.eq('sourceId',${JSON.stringify(sourceId)})).first())._id`)
      stage = 'tokenless approval draft'
      await client.mutation(api.jobs.addDraft, { jobId: id, payload: { kind: 'email', childId: null, to: recipient, subject: 'Approval probe', body: text, requirement: '', evidence: {} } })
      const job = (await client.query(api.jobs.list, {})).find(j => j._id === id)!, action = job.actions[0]
      stage = 'tokenless approval commit'
      await client.mutation(api.jobs.approve, { actions: [{ id: action._id, revision: action.revision, selectionVersion: 0 }] })
      stage = 'tokenless dispatch prevention'
      const deadline = Date.now() + 30000
      let latest
      do { await wait(250); latest = (await client.query(api.jobs.list, {})).find(j => j._id === id)?.actions[0]; if (latest && !['queued', 'executing'].includes(latest.status)) break } while (Date.now() < deadline)
      assert.equal(latest?.status, 'review', 'The tokenless connection must return to review before dispatch.')
      assert.equal(latest?.error, 'Google connection changed. Reconnect and review again.')
      assert.ok((latest as any)?.approvalId)
      assert.equal(await admin.mutation(internal.execution.claim, { actionId: action._id, approvalId: (latest as any).approvalId }), null, 'An earlier approval cannot dispatch a draft returned to review.')
      assert.equal(read(`return (await ctx.db.query('attempts').withIndex('by_action',q=>q.eq('actionId',${JSON.stringify(action._id)})).collect()).some(a=>a.dispatched)`), false)
      console.log('Actual local email approval accepted compose-only household correspondence; missing credentials prevented provider dispatch.')
    } finally {
      cli(priorRecipients === undefined ? ['env', 'remove', 'DAYMARK_TEST_EMAIL_RECIPIENTS'] : ['env', 'set', 'DAYMARK_TEST_EMAIL_RECIPIENTS'], priorRecipients)
    }
  } else if (reviewedOnly) {
    stage = 'reviewed draft handoff'
    for (const [subjectLine, body] of [
      ['Household supplies', 'Please bring the spare chairs on Saturday.'],
      ['Sola connector test', 'This is a synthetic Sola test message. No real family information is included.'],
      ['School absence', 'Maya will be absent on October 20, 2026.']
    ]) {
      const to = 'coordinator@example.test', text = `To: ${to}\nSubject: ${subjectLine}\n\n${body}`
      const id = await admin.mutation(internal.assistantSharing.prepare, { householdId, subject: owner, text, kind: 'email' })
      const deadline = Date.now() + 120000
      let job
      do { await wait(500); job = (await client.query(api.jobs.list, {})).find(j => j._id === id); if (job && !job.preparing) break } while (Date.now() < deadline)
      assert.ok(job && !job.preparing, 'The reviewed synthetic email did not finish.')
      assert.equal(job.actions.length, 1, 'The reviewed email handoff must retain an email action.')
      assert.deepEqual(Object.fromEntries(['kind', 'to', 'subject', 'body'].map(key => [key, (job!.actions[0].payload as any)[key]])), { kind: 'email', to, subject: subjectLine, body })
      assert.equal(job.actions[0].status, 'review')
      assert.equal(job.source?.text, text)
      console.log('Synthetic reviewed email: exact source, recipient, subject and body retained in one editable action; no provider write.')
    }
    for (const table of ['approvals', 'attempts', 'planEvents'] as const) assert.equal(read(`return (await ctx.db.query(${JSON.stringify(table)}).filter(q=>q.eq(q.field('householdId'),${JSON.stringify(householdId)})).collect()).length`), 0)
    console.log('Actual local model and durable reviewed-email handoff passed; Gmail was not called.')
  } else if (validationOnly) {
    stage = 'typed validation boundary'
    const text = 'Please propose a weekly packing routine for my review.', now = Date.now()
    append('sources', { householdId, text, hash: sourceHash(text), revision: 1, expiresAt: now + 86400000 })
    const sourceId = read(`return (await ctx.db.query('sources').withIndex('by_hash',q=>q.eq('householdId',${JSON.stringify(householdId)}).eq('hash',${JSON.stringify(sourceHash(text))})).first())._id`)
    append('jobs', { householdId, createdBy: owner, sourceId, interactive: true, preparing: true, cancelled: false, clarification: '' })
    const jobId = read(`return (await ctx.db.query('jobs').withIndex('by_source',q=>q.eq('sourceId',${JSON.stringify(sourceId)})).first())._id`)
    append('assistantRuns', { householdId, createdBy: owner, jobId, sourceId, sourceRevision: 1, sourceHash: sourceHash(text), version: 1, status: 'running', step: 0, attempts: 1, used: [], observations: '[]', refs: [{ kind: 'source', id: sourceId, version: 1, hash: sourceHash(text) }], createdAt: now, expiresAt: now + 86400000, lease: 'synthetic-validation', leaseUntil: now + 60000 })
    const id = read(`return (await ctx.db.query('assistantRuns').withIndex('by_job',q=>q.eq('jobId',${JSON.stringify(jobId)}).eq('sourceRevision',1)).first())._id`)
    const lease = { id, version: 1, lease: 'synthetic-validation' }
    const checked = await admin.mutation(internal.assistantCoordinator.commitStep, { ...lease, result: JSON.stringify({ tool: 'learn_process', query: 'Unsupported argument', lookbackDays: null, id: '', from: '', through: '', answer: '', drafts: [] }) })
    console.log(JSON.stringify({ syntheticValidationBoundary: true, accepted: checked.accepted, correction: checked.correction ?? 'none', failureCode: checked.failureCode ?? 'none' }))
    assert.deepEqual(checked, { accepted: false, correction: 'arguments' })
    await admin.mutation(internal.assistantCoordinator.fail, { ...lease, failureCode: 'model_output' })
    assert.equal(read(`return (await ctx.db.get(${JSON.stringify(id)})).learnRequested??false`), false)
    console.log('Synthetic validation boundary: actual local Convex returned the exact argument-correction category; no model call, tool execution or provider write.')
  } else {
  if (!learningOnly) {
  stage = 'conversation continuity'
  const dinner = await turn('What should I order for dinner?'), followup = await turn('just in general')
  assert.match(followup.job.clarification, /dinner|pizza|pasta|tacos|curry|takeout|stir.fry|bowl|sushi|noodle/i)
  assert.doesNotMatch(followup.job.clarification, /doesn.t give me a task|tell me what you need/i)
  assert.equal(dinner.run?.drafts.length ?? 0, 0); assert.equal(followup.run?.drafts.length ?? 0, 0)
  console.log('Synthetic dinner follow-up: actual model + durable conversation retained context; no task or write.')

  }
  stage = 'coordinator tool observations'
  append('connections', { householdId, subject: owner, provider: 'google', status: 'active', version: 1, scopes: [gmailReadScope], email })
  const connectionId = (await client.query(api.connections.overview, {})).items[0].id as Id<'connections'>, accountKey = sourceHash(JSON.stringify([connectionId, email])), now = Date.now()
  append('mailboxes', { householdId, createdBy: owner, connectionId, connectionVersion: 1, accountKey, version: 1, state: 'active', lookbackDays: 30, consentedAt: now, createdAt: now, nextCheckAt: now + 86400_000 })
  const mailboxId = (await client.query(api.mailbox.settings, {})).mailbox!.id as Id<'mailboxes'>
  const sourceText = 'Maya’s museum field trip is October 20, 2026, from 09:30 to 14:30 UTC at Oak School. Return the signed permission form by October 16, 2026. Bring a packed lunch.'
  append('mailMessages', { householdId, createdBy: owner, mailboxId, connectionId, connectionVersion: 1, accountKey, providerId: `synthetic-${suffix}`, threadId: `synthetic-thread-${suffix}`, sender: 'school@example.test', subject: 'Synthetic museum trip', text: sourceText, receivedAt: now, extraction: { format: 'plain', incomplete: true, truncated: false, attachments: true, issues: ['Attachments not read yet.'] }, labels: ['INBOX'], version: 1, contentHash: sourceHash(sourceText), expiresAt: now + 86400_000, dismissed: false })
  const messageId = (await client.query(api.mailbox.messages, {}))[0].id as Id<'mailMessages'>
  if (!learningOnly) {
  const task = await turn('What should I do about Maya’s museum plans? First use family_context, then mail_search with query museum, then calendar_events for October 20, 2026 UTC. Based on those observations, prepare one private parent task to return the permission form. Do not share, send or change a calendar. If no calendar is connected, say that availability is unknown and continue preparing the source-backed task.')
  assert.ok(task.run?.drafts.some(d => d.kind === 'task' && /form|permission/i.test(d.title + d.text)))
  const coordinator = read(`return await ctx.db.get(${JSON.stringify(task.run!.id)})`)
  for (const tool of ['family_context', 'mail_search', 'calendar_events']) assert.ok(coordinator.used.some((key: string) => JSON.parse(key)[0] === tool), `The model did not exercise ${tool}.`)
  assert.match(task.job.clarification, /calendar|availability|connected|unknown|not synced/i)
  assert.ok(coordinator.step <= 6 && coordinator.attempts <= 8)
  assert.deepEqual(await other.query(api.assistantCoordinator.list, {}), [])
  console.log('Synthetic coordinator: actual model chose family/mail/calendar reads and produced a private task; absent calendar coverage stayed explicit.')

  }
  stage = 'reviewed learning'
  const learning = await turn('Maya goes to Oak School. Every Sunday at 7 PM UTC I pack school bags. Please propose saving Maya’s school and a reusable weekly parent task to pack school bags, using the same Sunday 7 PM UTC schedule. These are suggestions for my review, not permission to remember or activate anything.')
  const sourceRevision = learning.job.source?.revision ?? 1
  const curationId = await client.mutation(api.learnedWorkflows.request, { jobId: learning.job._id as Id<'jobs'>, sourceRevision })
  const deadline = Date.now() + 150000
  let curation: any
  do { await wait(500); curation = read(`return await ctx.db.get(${JSON.stringify(curationId)})`); if (['complete', 'failed', 'cancelled'].includes(curation.status)) break } while (Date.now() < deadline)
  assert.equal(curation.status, 'complete', 'Synthetic model learning did not finish; private output withheld.')
  const suggestions = await client.query(api.learnedWorkflows.list, {}), routine = suggestions.find(s => s.kind === 'routine'), fact = suggestions.find(s => s.kind === 'fact')
  assert.ok(routine && fact, 'Expected both an explicit school fact and an explicit weekly process candidate.')
  assert.deepEqual(await other.query(api.learnedWorkflows.list, {}), [])
  assert.equal(read(`return (await ctx.db.query('memoryFacts').withIndex('by_key', q=>q.eq('householdId',${JSON.stringify(householdId)})).collect()).filter(f=>f.key.startsWith('family:')).length`), 0)
  assert.equal(read(`return (await ctx.db.query('routines').withIndex('by_household',q=>q.eq('householdId',${JSON.stringify(householdId)})).collect()).length`), 0)
  await assert.rejects(() => other.mutation(api.learnedWorkflows.approve, { id: routine!._id as Id<'learnedWorkflows'>, version: routine!.version, value: routine!.value, shareConfirmed: true }))
  await assert.rejects(() => client.mutation(api.learnedWorkflows.approve, { id: routine!._id as Id<'learnedWorkflows'>, version: routine!.version, value: routine!.value, shareConfirmed: false }))
  const reviewedRoutine = await client.mutation(api.learnedWorkflows.approve, { id: routine!._id as Id<'learnedWorkflows'>, version: routine!.version, value: routine!.value, shareConfirmed: true })
  const savedRoutine = read(`return await ctx.db.get(${JSON.stringify(reviewedRoutine.routineId)})`)
  assert.equal(savedRoutine.state, 'paused'); assert.equal(savedRoutine.timerId, undefined); assert.equal(savedRoutine.nextRunAt, undefined)
  const edited = { ...fact!.value, className: 'Synthetic Class A' }
  const next = await client.mutation(api.learnedWorkflows.update, { id: fact!._id as Id<'learnedWorkflows'>, version: fact!.version, value: edited })
  await assert.rejects(() => client.mutation(api.learnedWorkflows.approve, { id: fact!._id as Id<'learnedWorkflows'>, version: fact!.version, value: edited, shareConfirmed: true }))
  const approvedFact = await client.mutation(api.learnedWorkflows.approve, { id: fact!._id as Id<'learnedWorkflows'>, version: next, value: edited, shareConfirmed: true })
  assert.equal(read(`return await ctx.db.get(${JSON.stringify(approvedFact.factId)})`).value.className, 'Synthetic Class A')
  console.log('Synthetic learning: actual model proposed fact + weekly process; private/editable review required, routine saved paused, stale and cross-adult approval refused.')

  if (!learningOnly) {
  stage = 'multimodal attachment extraction'
  // Read the existing backend credential into this process only. Never print it,
  // pass it in process arguments, save it to a file or copy it to a browser.
  process.env.ANTHROPIC_API_KEY = cli(['env', 'get', 'ANTHROPIC_API_KEY']); process.env.DAYMARK_MODEL = cli(['env', 'get', 'DAYMARK_MODEL'])
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica), page = pdf.addPage([600, 400])
  page.drawText('Synthetic permission form', { x: 40, y: 340, size: 18, font }); page.drawText('Return the signed form by October 16, 2026.', { x: 40, y: 300, size: 12, font }); page.drawText('Museum trip: October 20, 2026, 09:30-14:30 UTC.', { x: 40, y: 270, size: 12, font })
  const pdfBytes = await pdf.save(), plainBytes = new TextEncoder().encode('Bring a packed lunch. Return the form by October 16, 2026.')
  for (const [index, name, mimeType, bytes] of [[1, 'Synthetic form.pdf', 'application/pdf', pdfBytes], [2, 'Synthetic notes.txt', 'text/plain', plainBytes]] as const) {
    const descriptor = attachmentDescriptors({ parts: [{ partId: `${index}`, filename: name, mimeType, body: { attachmentId: `synthetic_attachment_${index}`, size: bytes.length } }] }).descriptors[0]
    append('mailAttachments', { householdId, createdBy: owner, mailboxId, connectionId, mailboxVersion: 1, connectionVersion: 1, messageId, messageVersion: 1, messageHash: sourceHash(sourceText), accountKey, providerId: `synthetic-${suffix}`, ...descriptor, supported: undefined, status: 'running', version: 1, attempts: 1, consentedAt: now, createdAt: now, expiresAt: now + 86400_000, updatedAt: now, lease: `synthetic-attachment-${index}`, leaseUntil: Date.now() + 120000 })
    const attachmentId = read(`return (await ctx.db.query('mailAttachments').withIndex('by_message',q=>q.eq('messageId',${JSON.stringify(messageId)})).collect()).find(r=>r.partId===${JSON.stringify(String(index))})._id`)
    const lease = { id: attachmentId, version: 1, lease: `synthetic-attachment-${index}` }
    const result = await extractMailAttachment(bytes, mimeType, name, () => admin.query(internal.mailAttachments.permitted, lease))
    assert.match(result.output.text, /October 16,? 2026/i)
    assert.equal(await admin.mutation(internal.mailAttachments.finish, { ...lease, output: JSON.stringify(result.output), extractionMethod: result.extractionMethod, byteHash: createHash('sha256').update(bytes).digest('hex') }), true)
  }
  const extracted = await client.query(api.mailAttachments.list, { messageId })
  assert.equal(extracted.length, 2); assert.ok(extracted.every(a => a.status === 'complete'))
  assert.equal(extracted.find(a => a.mimeType === 'application/pdf')!.incomplete, true)
  assert.equal(extracted.find(a => a.mimeType === 'text/plain')!.extractionMethod, 'utf8')
  assert.deepEqual(await other.query(api.mailAttachments.list, {}), [])
  console.log('Synthetic attachments: actual model read a generated onepage PDF; literal UTF8 text read without a model. Private source-bound extraction saved; no Gmail download or provider write.')
  }
  for (const table of ['actions', 'approvals', 'attempts', 'mailDrafts', 'planEvents'] as const) assert.equal(read(`return (await ctx.db.query(${JSON.stringify(table)}).filter(q=>q.eq(q.field('householdId'),${JSON.stringify(householdId)})).collect()).length`), 0)
  console.log('Local assistant evaluation passed. These synthetic checks do not establish real Gmail/calendar reads, voice, sends or native acceptance.')
  }
} catch (cause) {
  if (approvalOnly) { const d = cause as { name?: string; code?: string; stack?: string }; console.log(JSON.stringify({ approvalProbeFailure: true, stage, name: d.name ?? 'UnknownError', assertion: d.code === 'ERR_ASSERTION', location: d.stack?.split('\n').find(line => line.includes('tests/integration/local-assistant.ts'))?.trim() })) }
  if (validationOnly) { const diagnostic = cause as { name?: string; status?: number; code?: string }; console.log(JSON.stringify({ syntheticValidationFailure: true, name: diagnostic.name ?? 'UnknownError', status: Number.isInteger(diagnostic.status) ? diagnostic.status : null, assertion: diagnostic.code === 'ERR_ASSERTION' })) }
  console.error(`Combined local assistant evaluation failed at: ${stage}. Potentially private model/provider output withheld.`)
  process.exitCode = 1
} finally {
  if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = priorKey
  if (priorModel === undefined) delete process.env.DAYMARK_MODEL; else process.env.DAYMARK_MODEL = priorModel
  if (householdId) {
    await client.mutation(api.privacy.deleteAccount, { confirmation: 'DELETE' })
    const job = read(`return await ctx.db.query('deletionJobs').filter(q=>q.eq(q.field('householdId'),${JSON.stringify(householdId)})).first()`)
    if (job) await admin.mutation(internal.privacy.eraseHousehold, { householdId, jobId: job._id })
  }
  if (allowlistChanged) cli(['env', 'set', 'DAYMARK_TEST_GOOGLE_EMAILS'], oldAllowlist)
  rmSync(scratch, { recursive: true, force: true })
  console.log(allowlistChanged ? 'Synthetic fixture cleanup completed; prior Gmail allowlist restored.' : 'Synthetic fixture cleanup completed; Gmail allowlist was unchanged.')
}
