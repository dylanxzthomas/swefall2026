import type { Doc } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'

export async function cancelWaitingDependencies(ctx: MutationCtx, action: Doc<'actions'>) {
  for (const dependent of await ctx.db.query('actions').withIndex('by_job', q => q.eq('jobId', action.jobId)).collect()) {
    if (dependent.dependsOn === action._id && dependent.status === 'waiting') await ctx.db.patch(dependent._id, { status: 'cancelled', approvalId: undefined })
  }
}
