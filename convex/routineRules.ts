import { emailWatchJobIssue } from './emailWatchRules'
import { routineBindingsIssue } from './mailRoutines'
import type { Doc } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'

/** Runs may prepare work, but the saved routine is never an execution approval. */
export async function routineJobIssue(ctx: Pick<QueryCtx, 'db'>, job: Doc<'jobs'>): Promise<string | null> {
  if (job.mailRoutineBindings?.some(binding => binding.householdId !== job.householdId || binding.createdBy !== job.createdBy)) return 'The private email routine binding changed. Share a fresh reviewed request.'
  const mailRoutineProblem = await routineBindingsIssue(ctx, job.mailRoutineBindings ?? [])
  if (mailRoutineProblem) return mailRoutineProblem
  const watchProblem = await emailWatchJobIssue(ctx, job)
  if (watchProblem) return watchProblem
  if (!job.routineId) return null
  const routine = await ctx.db.get(job.routineId)
  const member = routine && await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', routine.createdBy)).unique()
  if (!routine || routine.householdId !== job.householdId || routine.createdBy !== job.createdBy || member?.householdId !== job.householdId) return 'The adult who saved this routine no longer has access. Start a new request to continue.'
  if (routine.version !== job.routineVersion || !['active', 'finished'].includes(routine.state)) return 'This routine changed or stopped. Start a new request to use the saved details; nothing else will be sent from this occurrence.'
  return null
}
