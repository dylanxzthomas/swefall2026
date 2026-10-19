import { internalMutation, type MutationCtx } from './_generated/server'
import { internal } from './_generated/api'
import type { Doc } from './_generated/dataModel'

/** Preserve only the owner-scoped decision hash/version needed to prevent replay. */
export async function redactRoutineDecision(ctx: MutationCtx, row: Doc<'mailRoutineDecisions'>) {
  await ctx.db.patch(row._id, { mailboxId: undefined, messageId: undefined, sourceVersion: undefined, sourceHash: undefined, runId: undefined, proposalIds: undefined, expiresAt: undefined })
}

export async function expireRoutineDecisions(ctx: MutationCtx) {
  // Tombstones have no expiry. Exclude them so they cannot starve this bounded scan.
  const rows = await ctx.db.query('mailRoutineDecisions').withIndex('by_expiry', q => q.gte('expiresAt', 0).lte('expiresAt', Date.now())).take(100)
  for (const row of rows) {
    const routine = await ctx.db.get(row.routineId)
    if (!routine || routine.state === 'removed') await ctx.db.delete(row._id)
    else await redactRoutineDecision(ctx, row)
  }
  if (rows.length === 100) await ctx.scheduler.runAfter(0, internal.mailRoutineRetention.expire, {})
}

export const expire = internalMutation({ args: {}, handler: expireRoutineDecisions })
