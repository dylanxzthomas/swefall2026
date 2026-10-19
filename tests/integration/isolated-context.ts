import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { cp, readFile, writeFile, mkdtemp, rm, symlink, mkdir } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import { api } from '../../convex/_generated/api.js'

// Real model and durable workflow proof in a NEW throwaway database. The caller
// supplies only the model credentials in process memory, never provider tokens.
assert.ok(process.env.ANTHROPIC_API_KEY && process.env.DAYMARK_MODEL, 'Set the existing server model in private process memory first.')
const root = process.cwd(), config = JSON.parse(await readFile(join(root, '.convex/local/default/config.json'), 'utf8'))
assert.match(config.backendVersion, /^precompiled-[a-zA-Z0-9-]+$/)
const binary = join(homedir(), '.cache/convex/binaries', config.backendVersion, 'convex-local-backend')
const scratch = await mkdtemp(join(tmpdir(), 'sola-isolated-context-')), stage = join(scratch, 'source')
const savedMailProof = process.argv.includes('--saved-work-mail'), teardownOnly = process.argv.includes('--teardown-only')
let syntheticMailboxSeeded = false
const port = 3220, sitePort = 3221, origin = `http://127.0.0.1:${port}`
const runtimeErrors: string[] = []
let backend: ChildProcess | undefined, currentStage = 'isolated setup', complete = false
let failureDiagnostic: Record<string, unknown> | undefined
let lastTurnDiagnostic: Record<string, unknown> | undefined
let revisionDiagnostics: unknown[] = []
const started = Date.now(), checks: { name: string; elapsedMs: number; modelCalls: number }[] = []
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const baseEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NO_COLOR: '1', CONVEX_DISABLE_TELEMETRY: '1' }
async function command(file: string, args: string[], env = baseEnv, input?: string, timeout = 180000) {
  return new Promise<string>((resolveResult, reject) => {
    const child = spawn(file, args, { cwd: stage, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', value => { stdout += value.toString() })
    child.stderr.on('data', value => { stderr += value.toString() })
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Owned fixture command timed out; output withheld.')) }, timeout)
    child.once('error', () => { clearTimeout(timer); reject(new Error('Owned fixture command could not start.')) })
    child.once('exit', code => {
      clearTimeout(timer)
      if (code === 0) resolveResult(stdout.trim())
      else {
        // Fixed classifications only; CLI output can contain deployment keys.
        const category = /auth\.config|AUTH0|auth provider/i.test(stderr) ? 'auth_config' : /Cannot find|Could not resolve|module not found/i.test(stderr) ? 'module_resolution' : /typecheck/i.test(stderr) ? 'typecheck' : /connect|fetch|network|ENOTFOUND/i.test(stderr) ? 'transport' : 'command'
        reject(new Error(`Owned fixture ${category} failed (${code}); private output withheld.`))
      }
    })
    child.stdin.end(input)
  })
}
try {
  for (const p of [port, sitePort]) await new Promise<void>((resolvePort, reject) => {
    const probe = createServer(); probe.once('error', reject); probe.listen(p, '127.0.0.1', () => probe.close(error => error ? reject(error) : resolvePort()))
  })
  await mkdir(stage)
  for (const directory of ['convex', 'shared', 'server']) await cp(join(root, directory), join(stage, directory), { recursive: true, filter: path => !/\.test\.[^.]+$/.test(path) })
  for (const file of ['package.json', 'package-lock.json', 'convex.json', 'tsconfig.json', 'tsconfig.server.json']) await cp(join(root, file), join(stage, file))
  await symlink(join(root, 'node_modules'), join(stage, 'node_modules'), 'dir')
  // The fixture uses only the fresh deployment's admin-auth override. An empty
  // provider list prevents deployment-time discovery against any real IdP.
  await writeFile(join(stage, 'convex/auth.config.ts'), 'export default { providers: [] }\n')
  // This internal read exists only in the temporary staged deployment.
  await writeFile(join(stage, 'convex/contextProof.ts'), `import { internalQuery, internalMutation } from './_generated/server'; import {v} from 'convex/values'; import {sourceHash} from '../shared/daymark';
export const snapshot=internalQuery({args:{householdId:v.id('households')},handler:async(ctx,{householdId})=>({tasks:await ctx.db.query('personalTasks').withIndex('by_household',q=>q.eq('householdId',householdId)).collect(), jobs:await Promise.all((await ctx.db.query('jobs').withIndex('by_household',q=>q.eq('householdId',householdId)).collect()).map(async j=>({...j,source:await ctx.db.get(j.sourceId),actions:await ctx.db.query('actions').withIndex('by_job',q=>q.eq('jobId',j._id)).collect()}))),runs:await ctx.db.query('assistantRuns').withIndex('by_household',q=>q.eq('householdId',householdId)).collect(),usage:await ctx.db.query('assistantUsage').collect(),revisionDiagnostics:await ctx.db.query('contextDiagnostics').collect(),mailAgents:await ctx.db.query('mailAgents').withIndex('by_household',q=>q.eq('householdId',householdId)).collect(),proposals:await ctx.db.query('mailProposals').withIndex('by_household',q=>q.eq('householdId',householdId)).collect(),forbidden:{connections:(await ctx.db.query('connections').collect()).length,mailboxes:(await ctx.db.query('mailboxes').collect()).length,approvals:(await ctx.db.query('approvals').collect()).length,attempts:(await ctx.db.query('attempts').collect()).length,receipts:(await ctx.db.query('receipts').collect()).length}})});
export const recordRevision=internalMutation({args:{value:v.any()},handler:async(ctx,{value})=>{await ctx.db.insert('contextDiagnostics',{value})}});
export const seedMail=internalMutation({args:{householdId:v.id('households'),subject:v.string(),later:v.boolean()},handler:async(ctx,a)=>{
 const now=Date.now(),email='synthetic-inbox@example.test',householdId=a.householdId,createdBy=a.subject;
 let connection=await ctx.db.query('connections').withIndex('by_household',q=>q.eq('householdId',householdId)).first();
 if(!connection){const id=await ctx.db.insert('connections',{householdId,subject:createdBy,provider:'google',status:'active',version:1,scopes:['https://www.googleapis.com/auth/gmail.readonly'],email});connection=await ctx.db.get(id);}
 if(!connection)throw new Error('Synthetic seed failed');
 const connectionId=connection._id,accountKey=sourceHash(JSON.stringify([connectionId,email]));
 let box=await ctx.db.query('mailboxes').withIndex('by_owner',q=>q.eq('householdId',householdId).eq('createdBy',createdBy)).first();
 if(!box){const id=await ctx.db.insert('mailboxes',{householdId,createdBy,connectionId,connectionVersion:1,accountKey,version:1,state:'active',lookbackDays:30,consentedAt:now,createdAt:now,nextCheckAt:now+86400000});box=await ctx.db.get(id);
 await ctx.db.insert('privateTasks',{householdId,createdBy,key:'synthetic-form:0',keptHash:'synthetic',title:'Return museum permission form',text:'Maya museum trip November 2, 2026. Return the signed form by October 25, 2026. Already returned.',done:true,removed:false,version:1,createdAt:now,updatedAt:now});
 await ctx.db.insert('memberships',{householdId,subject:createdBy+'-neighbor',role:'adult'});
 await ctx.db.insert('privateTasks',{householdId,createdBy:createdBy+'-neighbor',key:'synthetic-neighbor:0',keptHash:'synthetic',title:'NEIGHBOR_ONLY_MEDICAL_NOTE',text:'NEIGHBOR_ONLY_MEDICAL_NOTE',done:false,removed:false,version:1,createdAt:now,updatedAt:now});}
 if(!box)throw new Error('Synthetic seed failed');
 const text=a.later?'A new museum trip for Maya is on December 7, 2026. A new signed permission form is required by December 1, 2026. This is separate from the November 2 trip.':'Reminder: return the signed permission form by October 25, 2026, for Maya’s museum trip on November 2, 2026. Nothing else is needed.',mailboxId=box._id;
 const messageId=await ctx.db.insert('mailMessages',{householdId,createdBy,mailboxId,connectionId,connectionVersion:1,accountKey,providerId:a.later?'later-trip':'new-thread-reminder',threadId:a.later?'later-trip-thread':'different-reminder-thread',sender:'school@example.test',subject:a.later?'December museum form':'November museum form reminder',text,receivedAt:now,extraction:{format:'plain',incomplete:false,truncated:false,attachments:false,issues:[]},labels:['INBOX'],version:1,contentHash:sourceHash(text),dismissed:false,expiresAt:now+86400000});
 const runId=await ctx.db.insert('mailRuns',{householdId,createdBy,mailboxId,mailboxVersion:1,connectionId,connectionVersion:1,accountKey,requestId:'poll:synthetic-'+(a.later?'later':'reminder'),requestHash:'synthetic',request:'Check for useful household follow-ups.',kind:'check',query:'',lookbackDays:30,mode:'history',scope:'inbox',status:'complete',version:1,scanned:1,segmentScanned:1,from:now-86400000,through:now,createdAt:now,expiresAt:now+86400000,messageIds:[messageId],hasMore:false});
 return{runId,source:{id:messageId,version:1,hash:sourceHash(text)}};
}});
`)
  // Test-only diagnostics store only synthetic revision inputs/outputs, before
  // a guarded commit can roll them back. Never shipped to an existing backend.
  const stagedSchema = join(stage, 'convex/schema.ts')
  await writeFile(stagedSchema, (await readFile(stagedSchema, 'utf8')).replace('export default defineSchema({', "export default defineSchema({ contextDiagnostics: defineTable({value:v.any()}),"))
  const stagedPreparation = join(stage, 'convex/preparation.ts'), preparation = await readFile(stagedPreparation, 'utf8')
  assert.ok(preparation.includes('const unchanged = binding &&'), 'Stage must include sequential clarification evidence preservation.')
  await writeFile(stagedPreparation, preparation.replace('  await ctx.runMutation(internal.revisions.finish,', "  await ctx.runMutation(internal.contextProof.recordRevision, {value:{before:context.action.payload,after:result.payload,answer:context.action.revisionRequest!.instruction,...(binding?{question:binding.question,fields:binding.fields}:{}),clarification:result.clarification}})\n  await ctx.runMutation(internal.revisions.finish,"))
  const stagedWorker = join(stage, 'convex/coordinatorWorker.ts')
  await writeFile(stagedWorker, (await readFile(stagedWorker, 'utf8')).replace('    const saved = await ctx.runMutation(internal.assistantCoordinator.commitStep,', "    await ctx.runMutation(internal.contextProof.recordRevision, {value:{kind:'coordinator',result}})\n    const saved = await ctx.runMutation(internal.assistantCoordinator.commitStep,"))
  await writeFile(stagedWorker, (await readFile(stagedWorker, 'utf8')).replace('  try { await ctx.runMutation(internal.assistantCoordinator.noticeFinished,', "  await ctx.runMutation(internal.contextProof.recordRevision, {value:{kind:'notice',result}})\n  try { await ctx.runMutation(internal.assistantCoordinator.noticeFinished,"))
  const instanceName = `anonymous-sola-proof-${randomBytes(5).toString('hex')}`, instanceSecret = randomBytes(32).toString('hex')
  const adminKey = await command(binary, ['keygen', 'admin-key', '--instance-name', instanceName, '--instance-secret', instanceSecret])
  backend = spawn(binary, ['--interface', '127.0.0.1', '--port', String(port), '--site-proxy-port', String(sitePort), '--instance-name', instanceName, '--instance-secret', instanceSecret, '--local-storage', join(scratch, 'storage'), '--disable-beacon', '--redact-logs-to-client', join(scratch, 'fixture.sqlite3')], { cwd: stage, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  const redact = (line: string) => [process.env.ANTHROPIC_API_KEY!, adminKey, instanceSecret].reduce((text, secret) => text.replaceAll(secret, '[redacted]'), line).replace(/sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, '[redacted]')
  for (const stream of [backend.stdout, backend.stderr]) {
    let buffer = ''
    stream?.on('data', value => { buffer += value.toString(); const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? ''; for (const line of lines) if (/error|exception|uncaught|timeout|limit/i.test(line)) { runtimeErrors.push(redact(line).slice(0, 2500)); if (runtimeErrors.length > 30) runtimeErrors.shift() } })
  }
  for (let i = 0; ; i++) {
    if (i > 100 || backend.exitCode !== null) throw new Error('Owned isolated backend did not start.')
    try { if (await (await fetch(`${origin}/instance_name`, { signal: AbortSignal.timeout(500) })).text() === instanceName) break } catch { /* startup only */ }
    await wait(200)
  }
  const env = { ...baseEnv, CONVEX_SELF_HOSTED_URL: origin, CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey }
  const cli = (args: string[], input?: string) => command(process.execPath, [join(stage, 'node_modules/convex/bin/main.js'), ...args], env, input)
  for (const [name, value] of Object.entries({ ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!, DAYMARK_MODEL: process.env.DAYMARK_MODEL!, DAYMARK_ENVIRONMENT: 'development', AUTH0_DOMAIN: 'https://synthetic.invalid', AUTH0_CLIENT_ID: 'synthetic-isolated', DAYMARK_TEST_GOOGLE_EMAILS: 'synthetic-inbox@example.test' })) await cli(['env', 'set', name], value)
  currentStage = 'isolated code deployment'
  await cli(['deploy', '--yes', '--typecheck', 'disable', '--codegen', 'disable'])
  type FixtureClient = ConvexHttpClient & { setAdminAuth(key: string, identity?: Record<string, unknown>): void }
  const parent = new ConvexHttpClient(origin) as FixtureClient, admin = new ConvexHttpClient(origin) as FixtureClient, other = new ConvexHttpClient(origin) as FixtureClient, subject = `proof-${randomUUID()}`
  parent.setAdminAuth(adminKey, { subject, tokenIdentifier: `https://synthetic.invalid|${subject}`, issuer: 'https://synthetic.invalid', email: `${subject}@example.test`, emailVerified: true })
  other.setAdminAuth(adminKey, { subject: `${subject}-other`, tokenIdentifier: `https://synthetic.invalid|${subject}-other`, issuer: 'https://synthetic.invalid' })
  admin.setAdminAuth(adminKey)
  const householdId = await parent.mutation(api.households.save, { timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }] })
  await other.mutation(api.households.save, { timezone: 'UTC', children: [] })
  const snapshot = () => admin.query(makeFunctionReference<'query'>('contextProof:snapshot'), { householdId }) as Promise<any>
  const calls = (state: any) => state.usage.reduce((n: number, row: any) => n + row.calls, 0) + state.jobs.filter((j: any) => j.preparationMetrics && !j.conversation).length + state.jobs.flatMap((j: any) => j.actions).reduce((n: number, a: any) => n + (a.revisionMetrics ? (a.corrections ?? 1) : 0), 0) + state.mailAgents.reduce((n: number, row: any) => n + row.attempts, 0)
  async function stateCheck() {
    assert.ok(Date.now() - started < 12 * 60000, 'Isolated proof reached its elapsed-time ceiling.')
    const state = await snapshot()
    revisionDiagnostics = state.revisionDiagnostics.map((row: any) => row.value)
    assert.deepEqual(state.forbidden, { connections: syntheticMailboxSeeded ? 1 : 0, mailboxes: syntheticMailboxSeeded ? 1 : 0, approvals: 0, attempts: 0, receipts: 0 }, 'Only token-free synthetic mailbox records are allowed; approvals and dispatch remain forbidden.')
    assert.ok(calls(state) <= 20, 'Isolated proof reached its model-call ceiling.')
    return state
  }
  async function turn(name: string, text: string) {
    currentStage = name
    assert.ok(calls(await stateCheck()) < 20, 'No model budget remains.')
    const at = Date.now(), id = await parent.mutation(api.jobs.submit, { text }), deadline = Date.now() + 150000
    while (Date.now() < deadline) {
      const state = await stateCheck(), job = state.jobs.find((j: any) => j._id === id)
      if (job && !job.preparing) {
        const run = state.runs.find((r: any) => r.jobId === id)
        if (job.emailPreparationFailed) {
          failureDiagnostic = { stage: name, failureCode: run?.failureCode ?? 'unrecorded', httpStatus: run?.failureStatus ?? null, step: run?.step ?? 0, attempts: run?.attempts ?? 0, modelCalls: calls(state), tools: (run?.used ?? []).map((key: string) => JSON.parse(key)[0]), corrections: JSON.parse(run?.observations ?? '[]').filter((o: any) => o.tool === 'validation').map((o: any) => o.result?.reason) }
          console.log(JSON.stringify({ syntheticFailure: failureDiagnostic }))
        }
        assert.ok(!job.emailPreparationFailed, `Synthetic ${name} failed preparation.`)
        if (run) assert.equal(run.status, 'complete', `Synthetic ${name} coordinator did not finish.`)
        lastTurnDiagnostic = { stage: name, receipt: job.clarification, tasks: state.tasks.map((task: any) => ({ title: task.title, done: task.done, removed: !!task.removed, version: task.version })), tools: (run?.used ?? []).map((key: string) => { const step = JSON.parse(key); return { tool: step[0], ...(step[6] ? { operation: step[6].operation, kind: step[6].kind, authorization: step[6].authorization, target: step[6].target, optionalFields: Object.keys(step[6]).filter(field => !['kind','operation','version','snapshot','authorization'].includes(field)) } : {}) } }) }
        checks.push({ name, elapsedMs: Date.now() - at, modelCalls: calls(state) })
        console.log(JSON.stringify({ stage: name, turnFinished: true, elapsedMs: Date.now() - at, modelCalls: calls(state) }))
        return { id, job, state, run }
      }
      await wait(350)
    }
    throw new Error(`Synthetic ${name} timed out.`)
  }
  const remaining = process.argv.includes('--remaining')
  let finalState: any
  if (teardownOnly) {
    currentStage = 'owned backend cleanup without model calls'
    finalState = await stateCheck()
    assert.equal(calls(finalState), 0)
  } else if (savedMailProof) {
    for (const later of [false, true]) {
      currentStage = later ? 'new responsibility despite completed older form' : 'completed responsibility cross-thread reminder'
      const at = Date.now(), seed = await admin.mutation(makeFunctionReference<'mutation'>('contextProof:seedMail'), { householdId, subject: `https://synthetic.invalid|${subject}`, later }) as any
      syntheticMailboxSeeded = true
      const agentId = await admin.mutation(makeFunctionReference<'mutation'>('mailFollowthrough:start'), { runId: seed.runId, runVersion: 1, sources: [seed.source] })
      assert.ok(agentId)
      const deadline = Date.now() + 150000
      let state: any, agent: any
      do {
        state = await stateCheck(); agent = state.mailAgents.find((r: any) => r._id === agentId)
        if (agent && ['complete', 'failed', 'cancelled'].includes(agent.status)) break
        await wait(350)
      } while (Date.now() < deadline)
      assert.equal(agent?.status, 'complete', 'Synthetic proactive preparation must finish.')
      assert.doesNotMatch(agent.observations, /NEIGHBOR_ONLY_MEDICAL_NOTE/)
      const proposals = state.proposals.filter((p: any) => p.runId === seed.runId)
      if (!later) assert.equal(proposals.length, 0, 'A completed responsibility must not be suggested again from a different thread.')
      else {
        assert.ok(proposals.some((p: any) => p.input.kind === 'task' && p.input.dueDate === '2026-12-01'), 'A new trip must retain its genuinely new form obligation.')
        assert.ok(proposals.every((p: any) => p.status === 'review'))
      }
      finalState = state
      checks.push({ name: currentStage, elapsedMs: Date.now() - at, modelCalls: calls(state) })
      console.log(JSON.stringify({ stage: currentStage, proposals: proposals.length, modelCalls: calls(state), passed: true }))
    }
  } else if (process.argv.includes('--clarification-only')) {
    const prepared = await turn('partial calendar request', 'Prepare a calendar draft for Maya: dentist appointment on November 2, 2026, at Oak Dental. I do not know the start or end time yet; ask me for them. Do not assume a duration.')
    assert.equal(prepared.job.actions.length, 1, 'A partial request must retain an editable action.')
    const original = prepared.job.actions[0], payload = original.payload
    assert.equal(payload.kind, 'calendar')
    assert.equal(payload.startTime, null)
    assert.equal(payload.endTime, null)
    assert.match(prepared.job.clarification, /time|start|end/i)
    let updated: any
    async function answerQuestion(name: string, text: string) {
      const answer = await turn(name, text)
      assert.ok(answer.run?.used.some((key: string) => JSON.parse(key)[0] === 'answer_request'), 'The model must select continuation of the observed question.')
      const deadline = Date.now() + 150000
      do {
        finalState = await stateCheck()
        updated = finalState.jobs.find((j: any) => j._id === prepared.id)
        if (!updated.actions[0]?.revisionRequest) break
        await wait(350)
      } while (Date.now() < deadline)
      assert.equal(updated.actions[0]._id, original._id)
      assert.equal(updated.actions[0].payload.startTime, '15:00')
    }
    const revisedAt = Date.now()
    await answerQuestion('answer start time only', 'Starts at 3 PM.')
    assert.equal(updated.actions[0].payload.endTime, null, 'Sola must ask rather than invent a duration.')
    assert.match(updated.clarification, /end|finish/i)
    const retainedStartEvidence = updated.actions[0].payload.evidence.startTime
    assert.ok(retainedStartEvidence && 'Starts at 3 PM.'.includes(retainedStartEvidence))
    await answerQuestion('answer remaining end time', '4 PM.')
    assert.equal(updated.actions[0].payload.evidence.startTime, retainedStartEvidence, 'Later answers must retain earlier grounded details.')
    assert.equal(updated.actions.length, 1)
    assert.equal(updated.actions[0]._id, original._id)
    assert.equal(updated.source.text, prepared.job.source.text, 'Continuation must not rewrite the original parent message.')
    assert.equal(updated.actions[0].payload.startTime, '15:00')
    assert.equal(updated.actions[0].payload.endTime, '16:00')
    for (const field of ['kind', 'title', 'childId', 'date', 'endDate', 'timezone', 'location', 'notes', 'allDay', 'targetId', 'operation']) assert.deepEqual(updated.actions[0].payload[field], payload[field], `Clarification changed unrelated ${field}.`)
    assert.equal(updated.actions[0].status, 'review')
    assert.equal(updated.actions[0].approvalId, undefined)
    assert.equal(finalState.jobs.flatMap((j: any) => j.actions).length, 1, 'Answering must not create a second event draft.')
    checks.push({ name: 'same-action missing times filled with no unrelated changes', elapsedMs: Date.now() - revisedAt, modelCalls: calls(finalState) })
  } else {
  if (!remaining) {
    await turn('dinner discussion', 'Suggest two easy dinners without mushrooms.')
    const followup = await turn('dinner follow-up', 'Make those vegetarian and dairy-free.')
    assert.match(followup.job.clarification, /bean|tofu|lentil|vegetarian|chickpea|vegetable/i)
    await turn('task creation', 'Add pack swim bag to my tasks')
    const renamed = await turn('task rename', 'Rename that task to Pack sports bag.')
    assert.equal(renamed.state.tasks.filter((t: any) => !t.removed).length, 1)
    assert.equal(renamed.state.tasks[0].title, 'Pack sports bag')
    assert.match(renamed.job.clarification, /^Updated/)
  } else await turn('seed task for remaining lifecycle', 'Add Pack sports bag to my tasks')
  if (process.argv.includes('--from-removal')) {
    const task = (await stateCheck()).tasks[0]
    await parent.mutation(api.personalTasks.setDone, { id: task._id, version: task.version, done: true })
  } else {
    const done = await turn('task completion', 'Mark that task done.')
    assert.equal(done.state.tasks[0].done, true)
  }
  const removed = await turn('task removal', 'Delete that task.')
  assert.equal(removed.state.tasks[0].removed, true)
  finalState = removed.state
  if (!process.argv.includes('--removal-only')) {
    const prepared = await turn('request preparation', 'Prepare this calendar request for review: Event: Synthetic park visit\nChild: Maya\nDate: 2026-11-02\nTime: 10:00 to 11:00\nLocation: Community park')
    assert.equal(prepared.job.actions.length, 1)
    assert.equal(prepared.job.actions[0].payload.kind, 'calendar')
    assert.equal(prepared.job.actions[0].status, 'review')
    await turn('request revision', 'Change that request to start at 11:00 and end at 12:00 instead.')
    const deadline = Date.now() + 150000
    let revised: any
    while (Date.now() < deadline) {
      revised = (await stateCheck()).jobs.find((j: any) => j._id === prepared.id)
      if (!revised.actions[0].revisionRequest) break
      await wait(350)
    }
    assert.equal(revised.actions[0].payload.startTime, '11:00')
    assert.equal(revised.actions[0].payload.endTime, '12:00')
    assert.equal(revised.actions[0].status, 'review')
    assert.equal(revised.actions[0].approvalId, undefined)
    const cancelled = await turn('request cancellation', 'Cancel that request.')
    assert.equal(cancelled.state.jobs.find((j: any) => j._id === prepared.id).cancelled, true)
    assert.equal(cancelled.state.jobs.find((j: any) => j._id === prepared.id).actions[0].status, 'cancelled')
    const hidden = await turn('request removal', 'Delete that request.')
    assert.equal(hidden.state.jobs.find((j: any) => j._id === prepared.id).assistantQuiet, true)
    assert.ok(hidden.state.jobs.find((j: any) => j._id === prepared.id).actions.length, 'Removal must preserve review records.')
    finalState = hidden.state
  }
  }
  assert.deepEqual(await other.query(api.jobs.list, {}), [], 'A separate identity must never see the synthetic parent’s work.')
  complete = true
  await mkdir(join(root, 'test-results'), { recursive: true })
  await writeFile(join(root, teardownOnly ? 'test-results/isolated-cleanup.json' : savedMailProof ? 'test-results/isolated-mail-work.json' : 'test-results/isolated-context.json'), JSON.stringify({ synthetic: true, realModel: !teardownOnly, realDurableBackend: true, freshDatabase: true, model: process.env.DAYMARK_MODEL, providerConnections: false, providerWrites: false, syntheticMailboxRecords: savedMailProof, scope: teardownOnly ? 'owned-runtime-cleanup-only' : savedMailProof ? 'saved-work-aware-proactive-mail' : process.argv.includes('--clarification-only') ? 'question-bound-calendar-continuation' : process.argv.includes('--removal-only') ? 'task-removal-only' : remaining ? 'remaining-lifecycle' : 'full-lifecycle', totalModelCalls: calls(finalState), elapsedMs: Date.now() - started, checks }, null, 2), { mode: 0o600 })
} catch (error) {
  // Every application datum here is synthetic, but transport output stays private.
  console.error(JSON.stringify({ passed: false, stage: currentStage, errorClass: error instanceof assert.AssertionError ? 'AssertionError' : 'FixtureError', message: error instanceof Error ? error.message : 'Unknown fixture failure' }))
  await mkdir(join(root, 'test-results'), { recursive: true })
  await writeFile(join(root, 'test-results/isolated-context-failure.json'), JSON.stringify({ synthetic: true, realModel: true, realDurableBackend: true, stage: currentStage, checks, ...(failureDiagnostic ? { diagnostic: failureDiagnostic } : {}), ...(lastTurnDiagnostic ? { lastTurn: lastTurnDiagnostic } : {}), revisionDiagnostics, runtimeErrors }, null, 2), { mode: 0o600 })
  process.exitCode = 1
} finally {
  if (backend && backend.exitCode === null && !backend.signalCode) {
    backend.kill('SIGTERM')
    await Promise.race([new Promise(resolveExit => backend!.once('exit', resolveExit)), wait(3000)])
    if (backend.exitCode === null && !backend.signalCode) {
      backend.kill('SIGKILL')
      await Promise.race([new Promise(resolveExit => backend!.once('exit', resolveExit)), wait(1000)])
    }
  }
  backend?.stdout?.destroy(); backend?.stderr?.destroy(); backend?.stdin?.destroy()
  await rm(scratch, { recursive: true, force: true })
  console.log(JSON.stringify({ isolatedProofComplete: complete, ownedBackendStopped: !backend || backend.exitCode !== null || !!backend.signalCode, ownedDatabaseRemoved: true }))
}
