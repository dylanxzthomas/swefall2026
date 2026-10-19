import type { QueryCtx } from './_generated/server'
import type { Doc } from './_generated/dataModel'
import { validMailConversation } from './mailConversation'
import { validWorkingContext } from './workingMemory'
type Owner = Pick<Doc<'jobs'>, 'householdId' | 'createdBy'>
/** Reuse identical checks within ONE immutable query snapshot, never across requests or writes. */
export function conversationValidation(ctx: Pick<QueryCtx, 'db'>) {
  const results = new Map<string, Promise<boolean>>()
  const once = (key: string, check: () => Promise<boolean>) => {
    let result = results.get(key)
    if (!result) { result = check(); results.set(key, result) }
    return result
  }
  return {
    mail(job: Owner, context: NonNullable<Doc<'jobs'>['mailContext']>) {
      return once(JSON.stringify(['mail', job.householdId, job.createdBy, context]), () => validMailConversation(ctx, job, context))
    },
    working(job: Owner, context: NonNullable<Doc<'jobs'>['workingContext']>) {
      return once(JSON.stringify(['working', job.householdId, job.createdBy, context.expiresAt, context.sources.map(r => [r.jobId, r.sourceId, r.revision, r.hash])]), () => validWorkingContext(ctx, job, context))
    },
  }
}
