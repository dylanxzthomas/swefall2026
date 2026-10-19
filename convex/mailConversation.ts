import type { Doc } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import { mailboxIssue, validMailSummary } from './mailbox'
import { sourceHash } from '../shared/daymark'

type Context = NonNullable<Doc<'jobs'>['mailContext']>
type ReadCtx = Pick<QueryCtx, 'db'>
export const unavailableMailContext = 'That private email context changed or is no longer available. Check Gmail again to continue.'
const summaryHash = (run: Doc<'mailRuns'>) => sourceHash(JSON.stringify([run.answer, run.coverage, run.evidence, run.summarySources]))

/** Revalidate provenance at reading and persistence, not only when a model starts. */
export async function validMailConversation(ctx: ReadCtx, job: Pick<Doc<'jobs'>, 'householdId' | 'createdBy'>, context: Context) {
  if (context.expiresAt <= Date.now() || context.messages.length > 10 || new Set(context.messages.map(m => m.id)).size !== context.messages.length) return false
  const mailbox = await ctx.db.get(context.mailboxId), run = await ctx.db.get(context.runId)
  if (!mailbox || mailbox.householdId !== job.householdId || mailbox.createdBy !== job.createdBy || mailbox.version !== context.mailboxVersion || await mailboxIssue(ctx, mailbox)) return false
  if (!run || run.householdId !== job.householdId || run.createdBy !== job.createdBy || run.mailboxId !== mailbox._id || run.mailboxVersion !== mailbox.version || run.connectionId !== mailbox.connectionId || run.connectionVersion !== mailbox.connectionVersion || run.accountKey !== mailbox.accountKey || run.version !== context.runVersion || run.expiresAt < context.expiresAt || summaryHash(run) !== context.summaryHash || !['complete', 'partial'].includes(run.status)) return false
  // A summary can depend on uncited sources as well as the displayed excerpts.
  if (!await validMailSummary(ctx, run)) return false
  for (const ref of context.messages) {
    const m = await ctx.db.get(ref.id)
    if (!m || m.householdId !== job.householdId || m.createdBy !== job.createdBy || m.mailboxId !== mailbox._id || m.accountKey !== mailbox.accountKey || m.connectionId !== mailbox.connectionId || m.connectionVersion !== mailbox.connectionVersion || m.version !== ref.version || m.contentHash !== ref.hash || m.expiresAt < context.expiresAt || m.dismissed) return false
  }
  return true
}

/** Recent visible results only. No new provider reads, grants or automatic sharing. */
export async function recentMailConversation(ctx: ReadCtx, job: Doc<'jobs'>) {
  const mailbox = await ctx.db.query('mailboxes').withIndex('by_owner', q => q.eq('householdId', job.householdId).eq('createdBy', job.createdBy)).order('desc').first()
  if (!mailbox || await mailboxIssue(ctx, mailbox)) return null
  const runs = await ctx.db.query('mailRuns').withIndex('by_context', q => q.eq('householdId', job.householdId).eq('createdBy', job.createdBy).gte('createdAt', job._creationTime - 86400_000).lte('createdAt', job._creationTime)).filter(q => q.and(q.neq(q.field('quiet'), true), q.neq(q.field('messageIds'), []), q.or(q.eq(q.field('status'), 'complete'), q.eq(q.field('status'), 'partial')))).order('desc').take(20)
  for (const run of runs) {
    // A quiet poll cannot replace the parent's recent check or search topic.
    if (run.quiet || run.createdAt > job._creationTime || run.createdAt < job._creationTime - 86400_000 || run.expiresAt <= Date.now() || run.mailboxId !== mailbox._id || !['complete', 'partial'].includes(run.status)) continue
    const ids = [...new Set([...(run.evidence ?? []).map(e => ctx.db.normalizeId('mailMessages', e.messageId)).filter(id => id !== null), ...run.messageIds.slice(-10)])].slice(0, 10)
    const rows = await Promise.all(ids.map(id => ctx.db.get(id)))
    const messages = rows.filter((m): m is Doc<'mailMessages'> => Boolean(m && m.householdId === job.householdId && m.createdBy === job.createdBy && m.mailboxId === mailbox._id && m.accountKey === mailbox.accountKey && m.connectionId === mailbox.connectionId && m.connectionVersion === mailbox.connectionVersion && m.expiresAt > Date.now() && !m.dismissed))
    // An empty run after a successful check should not erase that check's context.
    if (!messages.length) continue
    // A summary is usable only while every cited source remains valid.
    const grounded = Boolean(run.answer && run.summarySources?.length && run.evidence?.length && run.evidence.every(e => messages.some(m => m._id === e.messageId && m.text.includes(e.quote) && run.summarySources!.some(ref => ref.id === m._id && ref.version === m.version && ref.hash === m.contentHash))))
    const provenance: Context = { mailboxId: mailbox._id, mailboxVersion: mailbox.version, runId: run._id, runVersion: run.version, summaryHash: summaryHash(run), expiresAt: Math.min(run.expiresAt, ...messages.map(m => m.expiresAt)), messages: messages.map(m => ({ id: m._id, version: m.version, hash: m.contentHash })) }
    if (!await validMailConversation(ctx, job, provenance)) continue
    return { provenance, requestedAt: run.createdAt, requestedByParent: Boolean(run.agentRequested || !/^(poll|enable):/.test(run.requestId)), input: {
      request: run.request.slice(0, 2000), checkedAt: run.through, status: run.status,
      coverage: run.coverage ?? 'Only the supplied retrieved messages are available; this is not complete mailbox coverage.',
      ...(grounded ? { summary: run.answer!.slice(0, 4000), evidence: run.evidence } : {}),
      messages: messages.map(m => ({ id: m._id, sender: m.sender, subject: m.subject, receivedAt: m.receivedAt, text: m.text.slice(0, 2000), extraction: { ...m.extraction, truncated: m.extraction.truncated || m.text.length > 2000 } })),
    } }
  }
  return null
}
