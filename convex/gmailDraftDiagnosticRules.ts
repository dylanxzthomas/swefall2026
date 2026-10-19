import { v } from 'convex/values'
import { internalQuery } from './_generated/server'
import { mailDraftIssue } from './mailDrafts'
import { gmailReplyHash } from '../shared/gmailReply'
import type { Doc } from './_generated/dataModel'

export type DraftDiagnosticContext = {
  connection: Doc<'connections'>
  accountEmail: string
  gmailDraftId: string
  previous: NonNullable<Doc<'mailDrafts'>['previous']>
  pending: Pick<Doc<'mailDrafts'>, 'input' | 'replyRouting'> & { operationKey: string; approvedHash: string }
  approvalCurrent: boolean
}

/** Admin-only read context. It never claims a lease, renews approval, or schedules work. */
export const context = internalQuery({ args: { id: v.id('mailDrafts'), version: v.number() }, handler: async (ctx, args): Promise<DraftDiagnosticContext | null> => {
  if (process.env.DAYMARK_ENVIRONMENT !== 'development') return null
  const d = await ctx.db.get(args.id)
  if (!d || d.version !== args.version || !['failed', 'saved', 'review', 'uncertain'].includes(d.status) || !d.gmailDraftId || !d.previous || !d.operationKey || !d.approvedHash) return null
  if (!(process.env.DAYMARK_TEST_GOOGLE_EMAILS ?? '').split(',').map(value => value.trim().toLowerCase()).includes(d.accountEmail)) return null
  if (await mailDraftIssue(ctx, d, true)) return null
  try {
    if (d.approvedHash !== gmailReplyHash(d.input, d.replyRouting) || d.previous.approvedHash !== gmailReplyHash(d.previous.input, d.previous.replyRouting)) return null
  } catch { return null }
  const connection = await ctx.db.get(d.connectionId)
  if (!connection?.cipher) return null
  return { connection, accountEmail: d.accountEmail, gmailDraftId: d.gmailDraftId, previous: d.previous, pending: { input: d.input, replyRouting: d.replyRouting, operationKey: d.operationKey, approvedHash: d.approvedHash }, approvalCurrent: d.approvedAt !== undefined && d.approvedAt + 600_000 > Date.now() }
} })
