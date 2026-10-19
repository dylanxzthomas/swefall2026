import { ConvexError, v } from 'convex/values'
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { adult } from './access'
import { mailboxIssue } from './mailbox'
import { sourceHash } from '../shared/daymark'
import { mailRoutineDefinitionSchema, mailRoutineLimits, type MailRoutine, type MailRoutineOccurrence } from '../shared/mailRoutines'

type ReadCtx = Pick<QueryCtx, 'db'>
export type RoutineSnapshot = NonNullable<Doc<'mailAgents'>['routines']>[number]
export type RoutineBinding = NonNullable<Doc<'mailProposals'>['mailRoutineBindings']>[number]
export const mailRoutineDecisionLimit = 2000
const identity = { id: v.id('mailRoutines'), version: v.number() }

function definition(raw: unknown) {
  const parsed = mailRoutineDefinitionSchema.safeParse(raw)
  if (!parsed.success) throw new ConvexError(parsed.error.issues[0]?.message ?? 'Review the email routine details.')
  return parsed.data
}
async function owned(ctx: ReadCtx & Parameters<typeof adult>[0], id: Id<'mailRoutines'>, version?: number) {
  const { household, subject } = await adult(ctx), routine = await ctx.db.get(id)
  if (!routine || routine.householdId !== household._id || routine.createdBy !== subject) throw new ConvexError('This private email routine is unavailable.')
  if (version !== undefined && routine.version !== version) throw new ConvexError('This routine changed. Reopen its current version.')
  return routine
}
async function currentMailbox(ctx: ReadCtx, householdId: Id<'households'>, subject: string) {
  const boxes = await ctx.db.query('mailboxes').withIndex('by_owner', q => q.eq('householdId', householdId).eq('createdBy', subject)).order('desc').take(20)
  for (const mailbox of boxes) if (mailbox.state === 'active' && !await mailboxIssue(ctx, mailbox)) return mailbox
  throw new ConvexError('Enable Gmail email help with current access before activating this routine.')
}
async function routineIssue(ctx: ReadCtx, routine: Doc<'mailRoutines'>, mailbox?: Doc<'mailboxes'> | null) {
  if (routine.state !== 'active' || !routine.definition || !routine.activatedAt) return 'This email routine is paused, removed or changed.'
  const box = mailbox ?? (routine.mailboxId ? await ctx.db.get(routine.mailboxId) : null)
  if (!box || box._id !== routine.mailboxId || box.householdId !== routine.householdId || box.createdBy !== routine.createdBy || box.version !== routine.mailboxVersion || box.connectionId !== routine.connectionId || box.connectionVersion !== routine.connectionVersion || box.accountKey !== routine.accountKey || await mailboxIssue(ctx, box)) return 'Gmail access changed. Resume this routine after reviewing Gmail access.'
  return null
}
/** Reused by explicit reviewed learning. This never activates a routine or grants access. */
export async function createReviewedMailRoutine(ctx: MutationCtx, householdId: Id<'households'>, subject: string, raw: unknown, requestId: string): Promise<Id<'mailRoutines'>> {
  const household = await ctx.db.get(householdId), member = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', subject)).unique()
  if (!household || household.deleted || member?.householdId !== householdId) throw new ConvexError('This household is unavailable.')
  requestId = requestId.trim()
  if (!requestId || requestId.length > 200) throw new ConvexError('Use a valid routine request identifier.')
  const value = definition(raw), hash = sourceHash(JSON.stringify(value))
  const previous = await ctx.db.query('mailRoutines').withIndex('by_request', q => q.eq('householdId', householdId).eq('createdBy', subject).eq('requestId', requestId)).unique()
  if (previous) { if (previous.requestHash !== hash) throw new ConvexError('This request identifier belongs to a different routine.'); return previous._id }
  const rows = (await Promise.all((['active', 'paused'] as const).map(state => ctx.db.query('mailRoutines').withIndex('by_owner', q => q.eq('householdId', householdId).eq('createdBy', subject).eq('state', state)).take(mailRoutineLimits.perAdult)))).flat()
  const identical = rows.find(r => r.definitionHash === hash)
  if (identical) return identical._id
  if (rows.length >= mailRoutineLimits.perAdult) throw new ConvexError(`You can save up to ${mailRoutineLimits.perAdult} email routines. Remove one before adding another.`)
  return ctx.db.insert('mailRoutines', { householdId, createdBy: subject, requestId, requestHash: hash, definition: value, definitionHash: hash, version: 1, state: 'paused', decisionCount: 0, createdAt: Date.now(), updatedAt: Date.now() })
}
export const create = mutation({ args: { definition: v.any(), requestId: v.string() }, handler: async (ctx, args) => {
  const { household, subject } = await adult(ctx)
  return createReviewedMailRoutine(ctx, household._id, subject, args.definition, args.requestId)
} })
export const list = query({ args: {}, handler: async (ctx): Promise<MailRoutine[]> => {
  const { household, subject } = await adult(ctx)
  const rows = (await Promise.all((['active', 'paused'] as const).map(state => ctx.db.query('mailRoutines').withIndex('by_owner', q => q.eq('householdId', household._id).eq('createdBy', subject).eq('state', state)).take(mailRoutineLimits.perAdult)))).flat()
  return Promise.all(rows.sort((a, b) => b.createdAt - a.createdAt).map(async r => ({ id: r._id, version: r.version, state: r.state, definition: r.definition, activatedAt: r.activatedAt, lastPreparedAt: r.lastPreparedAt, createdAt: r.createdAt, updatedAt: r.updatedAt, ...(r.state === 'active' ? { issue: await routineIssue(ctx, r) ?? (r.decisionCount >= mailRoutineDecisionLimit ? 'This routine reached its saved-message limit. Remove it and create a new routine for future emails.' : undefined) } : {}) })))
} })
async function saveVersion(ctx: MutationCtx, routine: Doc<'mailRoutines'>, raw: unknown, paused: boolean) {
  if (routine.state === 'removed') throw new ConvexError('This routine was removed.')
  const value = definition(raw), mailbox = paused ? null : await currentMailbox(ctx, routine.householdId, routine.createdBy)
  if (!paused && routine.decisionCount >= mailRoutineDecisionLimit) throw new ConvexError('This routine reached its saved-message limit. Create a new routine for future emails.')
  const version = routine.version + 1
  await ctx.db.patch(routine._id, { version, definition: value, definitionHash: sourceHash(JSON.stringify(value)), state: paused ? 'paused' : 'active', activatedAt: mailbox ? Date.now() : undefined, mailboxId: mailbox?._id, mailboxVersion: mailbox?.version, connectionId: mailbox?.connectionId, connectionVersion: mailbox?.connectionVersion, accountKey: mailbox?.accountKey, updatedAt: Date.now() })
  return version
}
export const update = mutation({ args: { ...identity, definition: v.any() }, handler: async (ctx, args) => {
  const r = await owned(ctx, args.id, args.version)
  return saveVersion(ctx, r, args.definition, r.state !== 'active')
} })
export const setPaused = mutation({ args: { ...identity, paused: v.boolean() }, handler: async (ctx, args) => {
  const r = await owned(ctx, args.id, args.version)
  if (args.paused && r.state === 'paused' || !args.paused && r.state === 'active' && !await routineIssue(ctx, r)) return r.version
  return saveVersion(ctx, r, r.definition, args.paused)
} })
export const remove = mutation({ args: identity, handler: async (ctx, args) => {
  const r = await owned(ctx, args.id, args.version)
  if (r.state === 'removed') return r.version
  await ctx.db.patch(r._id, { state: 'removed', definition: undefined, version: r.version + 1, activatedAt: undefined, lastPreparedAt: undefined, mailboxId: undefined, mailboxVersion: undefined, connectionId: undefined, connectionVersion: undefined, accountKey: undefined, updatedAt: Date.now() })
  await ctx.scheduler.runAfter(0, internal.mailRoutines.eraseDecisions, { id: r._id })
  return r.version + 1
} })
export const eraseDecisions = internalMutation({ args: { id: v.id('mailRoutines') }, handler: async (ctx, { id }) => {
  const r = await ctx.db.get(id)
  if (r && r.state !== 'removed') return
  const rows = await ctx.db.query('mailRoutineDecisions').withIndex('by_routine', q => q.eq('routineId', id)).take(100)
  for (const row of rows) await ctx.db.delete(row._id)
  if (rows.length === 100) await ctx.scheduler.runAfter(0, internal.mailRoutines.eraseDecisions, { id })
} })
export const history = query({ args: { id: v.id('mailRoutines') }, handler: async (ctx, args): Promise<MailRoutineOccurrence[]> => {
  const r = await owned(ctx, args.id)
  if (r.state === 'removed') return []
  const rows = await ctx.db.query('mailRoutineDecisions').withIndex('by_history', q => q.eq('routineId', r._id).eq('decision', 'prepared')).order('desc').take(mailRoutineLimits.history)
  return Promise.all(rows.map(async row => {
    const expired = !row.expiresAt || row.expiresAt <= Date.now(), proposals = expired ? [] : await Promise.all((row.proposalIds ?? []).map(id => ctx.db.get(id)))
    const current = proposals.some(p => p && p.mailRoutineBindings?.some(b => b.routineId === r._id && b.routineVersion === row.routineVersion && b.messageId === row.messageId))
    return { id: row._id, routineVersion: row.routineVersion, createdAt: row.createdAt, status: expired ? 'expired' : r.version !== row.routineVersion || r.state !== 'active' || !current ? 'superseded' : 'prepared', summary: expired ? 'The original email has expired.' : current ? 'Prepared private work for your review.' : 'This preparation has been replaced.', ...(!expired && row.runId ? { runId: row.runId } : {}) }
  }))
} })

export async function activeRoutineSnapshots(ctx: ReadCtx, mailbox: Doc<'mailboxes'>): Promise<RoutineSnapshot[]> {
  const rows = await ctx.db.query('mailRoutines').withIndex('by_owner', q => q.eq('householdId', mailbox.householdId).eq('createdBy', mailbox.createdBy).eq('state', 'active')).take(mailRoutineLimits.perAdult + 1)
  if (rows.length > mailRoutineLimits.perAdult) throw new ConvexError('Email routines exceed the preparation limit.')
  const snapshots: RoutineSnapshot[] = []
  for (const r of rows) if (r.decisionCount < mailRoutineDecisionLimit && !await routineIssue(ctx, r, mailbox)) snapshots.push({ id: r._id, version: r.version, definitionHash: r.definitionHash, activatedAt: r.activatedAt! })
  return snapshots
}
export async function validRoutineSnapshots(ctx: ReadCtx, mailbox: Doc<'mailboxes'>, snapshots: readonly RoutineSnapshot[]) {
  for (const s of snapshots) { const r = await ctx.db.get(s.id); if (!r || r.version !== s.version || r.definitionHash !== s.definitionHash || r.activatedAt !== s.activatedAt || await routineIssue(ctx, r, mailbox)) return false }
  return true
}
export const routineMessageKey = (m: Doc<'mailMessages'>) => sourceHash(JSON.stringify([m.accountKey, m.providerId]))
export async function availableRoutineMessages(ctx: ReadCtx, snapshots: readonly RoutineSnapshot[], messages: readonly Doc<'mailMessages'>[]) {
  const output: { id: Id<'mailRoutines'>; version: number; definition: NonNullable<Doc<'mailRoutines'>['definition']>; eligibleMessageIds: Id<'mailMessages'>[] }[] = []
  for (const s of snapshots) {
    const r = await ctx.db.get(s.id)
    if (!r?.definition || r.decisionCount >= mailRoutineDecisionLimit) continue
    const ids: Id<'mailMessages'>[] = []
    for (const m of messages) if (m.receivedAt > s.activatedAt && !await ctx.db.query('mailRoutineDecisions').withIndex('by_key', q => q.eq('routineId', s.id).eq('key', routineMessageKey(m))).unique()) ids.push(m._id)
    if (ids.length) output.push({ id: s.id, version: s.version, definition: r.definition, eligibleMessageIds: ids.slice(0, mailRoutineDecisionLimit - r.decisionCount) })
  }
  return output
}
export function routineBinding(snapshot: RoutineSnapshot, mailbox: Doc<'mailboxes'>, message: Doc<'mailMessages'>): RoutineBinding {
  return { routineId: snapshot.id, routineVersion: snapshot.version, definitionHash: snapshot.definitionHash, activatedAt: snapshot.activatedAt, householdId: mailbox.householdId, createdBy: mailbox.createdBy, mailboxId: mailbox._id, mailboxVersion: mailbox.version, connectionId: mailbox.connectionId, connectionVersion: mailbox.connectionVersion, accountKey: mailbox.accountKey, messageId: message._id, sourceVersion: message.version, sourceHash: message.contentHash, receivedAt: message.receivedAt, expiresAt: message.expiresAt }
}
/** Used before review mutations and dispatch. Verified provider receipts retain their real outcomes. */
export async function routineBindingsIssue(ctx: ReadCtx, bindings: readonly RoutineBinding[] | undefined): Promise<string | null> {
  for (const b of bindings ?? []) {
    const r = await ctx.db.get(b.routineId), m = await ctx.db.get(b.messageId), box = await ctx.db.get(b.mailboxId)
    if (!r || r.householdId !== b.householdId || r.createdBy !== b.createdBy || r.version !== b.routineVersion || r.definitionHash !== b.definitionHash || r.activatedAt !== b.activatedAt || await routineIssue(ctx, r, box) || !box || box.version !== b.mailboxVersion || box.connectionId !== b.connectionId || box.connectionVersion !== b.connectionVersion || box.accountKey !== b.accountKey || !m || m.householdId !== b.householdId || m.createdBy !== b.createdBy || m.mailboxId !== b.mailboxId || m.accountKey !== b.accountKey || m.connectionId !== b.connectionId || m.connectionVersion !== b.connectionVersion || m.version !== b.sourceVersion || m.contentHash !== b.sourceHash || m.receivedAt !== b.receivedAt || m.receivedAt <= b.activatedAt || m.dismissed || m.expiresAt <= Date.now() || b.expiresAt <= Date.now()) return 'This email routine, its source or Gmail access changed. Review fresh preparation before continuing.'
    if (m.threadId) {
      const latest = await ctx.db.query('mailMessages').withIndex('by_thread', q => q.eq('householdId', m.householdId).eq('createdBy', m.createdBy).eq('accountKey', m.accountKey).eq('threadId', m.threadId)).order('desc').first()
      if (latest && latest._id !== m._id && latest.expiresAt > Date.now() && (latest.receivedAt > m.receivedAt || latest.receivedAt === m.receivedAt && latest._creationTime > m._creationTime)) return 'A newer email changed this routine preparation. Review the current source.'
    }
  }
  return null
}
