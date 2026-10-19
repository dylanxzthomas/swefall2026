import { v, ConvexError } from 'convex/values'
import { mutation, internalMutation, internalQuery } from './_generated/server'
import { internal } from './_generated/api'
import { adult } from './access'
import { expireMemoryProposals } from './memoryProposals'
import { retainReviewedTask } from './mailFollowthrough'
import { expireRoutineDecisions } from './mailRoutineRetention'
export const expireSources = internalMutation({ args: {}, handler: async ctx => {
  await expireRoutineDecisions(ctx)
  await expireMemoryProposals(ctx)
  for (const cache of await ctx.db.query('workingMemories').withIndex('by_expiry', q => q.gte('context.expiresAt', 0).lte('context.expiresAt', Date.now())).take(100)) if (cache.context) await ctx.db.patch(cache._id, { notes: undefined, context: undefined })
  for(const run of await ctx.db.query('assistantRuns').withIndex('by_expiry',q=>q.lte('expiresAt',Date.now())).take(100)){const job=await ctx.db.get(run.jobId);if(job?.assistantRunId===run._id&&job.conversation)await ctx.db.patch(job._id,{clarification:'This private preparation has expired.'});await ctx.db.delete(run._id)}
  for (const proposal of await ctx.db.query('mailProposals').withIndex('by_expiry', q => q.lte('expiresAt', Date.now())).take(100)) { await retainReviewedTask(ctx, proposal); await ctx.db.delete(proposal._id) }
  for (const table of ['voiceRequests','calendarAssistRuns','assistantUsage','assistantMailRequests','calendarFeedRuns','calendarFeedEvents','mailAttachments','workflowCurations','learnedWorkflows','mailAgents'] as const) for (const row of await ctx.db.query(table).withIndex('by_expiry', q => q.lte('expiresAt', Date.now())).take(100))await ctx.db.delete(row._id)
  for (const message of await ctx.db.query('mailMessages').withIndex('by_expiry', q => q.lte('expiresAt', Date.now())).take(100)) await ctx.db.delete(message._id)
  for (const run of await ctx.db.query('mailRuns').withIndex('by_expiry', q => q.lte('expiresAt', Date.now())).take(100)) await ctx.db.delete(run._id)
  await ctx.scheduler.runAfter(0, internal.mailDrafts.purgeExpired, {})
  for(const session of await ctx.db.query('voiceSessions').withIndex('by_expiry',q=>q.lte('expiresAt',Date.now()-86400000)).take(100)) if(!session.providerCallId)await ctx.db.delete(session._id)
  for (const item of await ctx.db.query('inbound').withIndex('by_expiry', q => q.lt('expiresAt', Date.now())).take(100)) await ctx.db.delete(item._id)
  for (const source of await ctx.db.query('sources').withIndex('by_expiry', q => q.lt('expiresAt', Date.now())).take(100)) {
    if (source.text !== undefined || source.email || source.attachmentIds?.length) await ctx.db.patch(source._id, { email: undefined, text: undefined, attachmentIds: [] })
    for (const job of await ctx.db.query('jobs').withIndex('by_source', q => q.eq('sourceId', source._id)).collect()) if (job.conversation) await ctx.db.patch(job._id, { clarification: 'This conversation has expired.' })
    for (const job of await ctx.db.query('jobs').withIndex('by_source', q => q.eq('sourceId', source._id)).collect()) if (job.emailTriage) await ctx.db.patch(job._id, { emailTriage: undefined })
    for (const job of await ctx.db.query('jobs').withIndex('by_source', q => q.eq('sourceId', source._id)).collect()) for (const t of await ctx.db.query('emailTaskSuggestions').withIndex('by_job', q => q.eq('jobId', job._id)).collect()) {
      if (t.status === 'saved') await ctx.db.patch(t._id, { evidence: [], issue: undefined })
      else await ctx.db.delete(t._id)
    }
    // Remove quoted source excerpts; retain only the reviewed deliverable and minimal receipt.
    for (const job of await ctx.db.query('jobs').withIndex('by_source', q => q.eq('sourceId', source._id)).collect()) for (const a of await ctx.db.query('actions').withIndex('by_job', q => q.eq('jobId', job._id)).collect()) if (Object.keys(a.payload.evidence ?? {}).length || a.revisionRequest) await ctx.db.patch(a._id, { payload: { ...a.payload, evidence: {} }, revisionRequest: undefined, ...(a.revisionRequest ? { revision: a.revision + 1, error: 'The original source expired. The draft is preserved for manual review.' } : {}) })
    await ctx.db.patch(source._id, { expiresAt: Number.MAX_SAFE_INTEGER })
  }
  for (const file of await ctx.db.query('attachments').withIndex('by_expiry', q => q.lt('expiresAt', Date.now())).take(100)) { await ctx.storage.delete(file.storageId); await ctx.db.delete(file._id) }
} })
export const deleteAccount = mutation({ args: { confirmation: v.string() }, handler: async (ctx, args) => {
  const { household, subject } = await adult(ctx), identity = (await ctx.auth.getUserIdentity())!
  if (args.confirmation !== 'DELETE') throw new ConvexError('Type DELETE to remove this household’s Daymark data.')
  // Block authorization immediately. Cleanup waits for in-flight actions to settle.
  await ctx.db.patch(household._id, { deleted: true })
  const jobId = await ctx.db.insert('deletionJobs', { householdId: household._id, requestedAt: Date.now(), status: 'pending', subject, auth0UserId: identity.subject, identityStatus: 'pending', attempts: 0 })
  for (const c of await ctx.db.query('connections').withIndex('by_household', q => q.eq('householdId', household._id)).collect()) {
    await ctx.db.patch(c._id, { status: 'revoked', version: c.version + 1 })
    if (c.provider !== 'apple') await ctx.scheduler.runAfter(0, c.provider === 'microsoft' ? internal.microsoft.revoke : internal.google.revoke, { id: c._id, version: c.version + 1 })
  }
  await ctx.scheduler.runAfter(0, internal.identityDeletion.remove, { jobId })
  await ctx.scheduler.runAfter(180_000, internal.privacy.eraseHousehold, { householdId: household._id, jobId })
} })
export const eraseHousehold = internalMutation({ args: { householdId: v.id('households'), jobId: v.id('deletionJobs') }, handler: async (ctx, args) => {
  const household = await ctx.db.get(args.householdId)
  if (!household?.deleted) return
  // Bounded batches, including private storage; retryable and idempotent.
  const tables = ['voiceRequests','calendarAssistRuns','assistantUsage','privateTasks','assistantMailRequests','assistantRuns','calendarFeeds','calendarFeedRuns','calendarFeedEvents','mailAttachments','workflowCurations','learnedWorkflows','appointmentBookings','voiceSessions','workingMemories', 'mailboxes', 'mailRoutines', 'mailRoutineDecisions', 'mailAgents', 'mailProposals', 'mailRuns', 'mailMessages', 'mailDrafts', 'connectorRequests', 'connectorRequestKeys', 'memoryProposals', 'emailWatches', 'emailWatchMessages', 'emailTaskSuggestions', 'routineOccurrences', 'routineVersions', 'routines', 'library', 'personalTasks', 'personalPreferences', 'pickupPreferences', 'notificationPreferences', 'devices', 'notifications', 'forwarding', 'inbound', 'attachments', 'sources', 'jobs', 'actions', 'approvals', 'attempts', 'receipts', 'planEvents', 'connectionPreferences', 'connections', 'oauthStates', 'caregivers', 'pickupRequests', 'memoryFacts', 'legacyRecords', 'memberships'] as const
  const connections = await ctx.db.query('connections').withIndex('by_household', q => q.eq('householdId', args.householdId)).collect()
  if (connections.some(c => c.status === 'revocation_unconfirmed' || c.cipher)) await ctx.db.patch(args.jobId, { providerRevocation: 'unconfirmed' })
  let remaining = false
  for (const table of tables) {
    const records = table === 'voiceRequests' || table === 'calendarAssistRuns' || table === 'assistantUsage' || table === 'privateTasks' || table === 'assistantMailRequests' || table === 'assistantRuns' || table === 'calendarFeeds' || table === 'calendarFeedRuns' || table === 'calendarFeedEvents' || table === 'mailAttachments' || table === 'workflowCurations' || table === 'learnedWorkflows' || table === 'appointmentBookings' || table === 'voiceSessions' || table === 'workingMemories' || table === 'mailboxes' || table === 'mailRoutines' || table === 'mailRoutineDecisions' || table === 'mailAgents' || table === 'mailProposals' || table === 'mailRuns' || table === 'mailMessages' || table === 'mailDrafts' || table === 'connectorRequests' || table === 'connectorRequestKeys' || table === 'memoryProposals' || table === 'emailWatches' || table === 'emailWatchMessages' || table === 'emailTaskSuggestions' || table === 'routines' || table === 'routineVersions' || table === 'routineOccurrences'
      ? await ctx.db.query(table).withIndex('by_household', q => q.eq('householdId', args.householdId)).take(50)
      : await ctx.db.query(table).filter(q => q.eq(q.field('householdId'), args.householdId)).take(50)
    for (const record of records) { if ((table === 'attachments' || table === 'library') && 'storageId' in record && record.storageId) await ctx.storage.delete(record.storageId); await ctx.db.delete(record._id) }
    if (records.length === 50) remaining = true
  }
  if (remaining) await ctx.scheduler.runAfter(0, internal.privacy.eraseHousehold, args)
  else {
    await ctx.db.delete(args.householdId)
    const deletion = await ctx.db.get(args.jobId)
    if (deletion?.identityStatus === 'deleted' && deletion.providerRevocation !== 'unconfirmed') await ctx.db.delete(args.jobId)
    else await ctx.db.patch(args.jobId, { dataErased: true, status: 'family_data_erased' })
  }
} })

export const deletionContext = internalQuery({ args: { jobId: v.id('deletionJobs') }, handler: (ctx, { jobId }) => ctx.db.get(jobId) })
export const identityResult = internalMutation({ args: { jobId: v.id('deletionJobs'), status: v.string() }, handler: async (ctx, args) => {
  const job = await ctx.db.get(args.jobId)
  if (!job) return
  if (args.status === 'deleted' && job.dataErased && job.providerRevocation !== 'unconfirmed') { await ctx.db.delete(job._id); return }
  await ctx.db.patch(job._id, { identityStatus: args.status, attempts: (job.attempts ?? 0) + 1, ...(args.status === 'deleted' ? { auth0UserId: undefined } : {}) })
} })
export const retryIdentities = internalMutation({ args: {}, handler: async ctx => {
  for (const job of await ctx.db.query('deletionJobs').take(100)) if (job.identityStatus !== 'deleted' && (job.attempts ?? 0) < 168) await ctx.scheduler.runAfter(0, internal.identityDeletion.remove, { jobId: job._id })
} })

export const cleanupStorage = internalMutation({ args: { cursor: v.optional(v.string()), cutoff: v.optional(v.number()) }, handler: async (ctx, args): Promise<void> => {
  const rollout = await ctx.db.query('storageCleanup').withIndex('by_key', q => q.eq('key', 'private-files')).unique()
  if (!rollout) return
  // The grace period exceeds the bounded action lifetime, so an active upload/copy is never swept.
  const cutoff = Math.min(args.cutoff ?? Date.now() - 86400000, Date.now() - 86400000)
  if (cutoff <= rollout.since) return
  const files = await ctx.db.system.query('_storage').withIndex('by_creation_time', q => q.gte('_creationTime', rollout.since).lt('_creationTime', cutoff)).paginate({ cursor: args.cursor ?? null, numItems: 100 })
  for (const file of files.page) {
    const source = await ctx.db.query('attachments').withIndex('by_storage', q => q.eq('storageId', file._id)).first()
    const kept = await ctx.db.query('library').withIndex('by_storage', q => q.eq('storageId', file._id)).first()
    if (!source && !kept) await ctx.storage.delete(file._id)
  }
  if (!files.isDone) await ctx.scheduler.runAfter(0, internal.privacy.cleanupStorage, { cursor: files.continueCursor, cutoff })
} })
