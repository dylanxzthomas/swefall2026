import { WorkflowManager } from '@convex-dev/workflow'
import { v } from 'convex/values'
import { components, internal } from './_generated/api'
const workflow = new WorkflowManager(components.workflow, { workpoolOptions: { maxParallelism: 4 } })
export const prepare = workflow.define({ args: { jobId: v.id('jobs'), sourceRevision: v.number() } }).handler(async (step, args): Promise<void> => {
  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (!await step.runQuery(internal.jobs.waitingForEarlier, args)) {
        await step.runAction(internal.preparation.prepare, args, { retry: false })
        return
      }
      await step.sleep(3000)
    }
    await step.runMutation(internal.jobs.prepared, { ...args, actions: [], preparationFailed: true, clarification: 'An earlier request is still preparing. Your message is saved; try again after it finishes.' })
  }
  catch { await step.runMutation(internal.jobs.prepared, { ...args, actions: [], preparationFailed: true, clarification: 'Preparation stopped. Your source is saved. Edit the source to try again.' }) }
})
export const execute = workflow.define({ args: { actionId: v.id('actions'), approvalId: v.id('approvals') } }).handler(async (step, args): Promise<void> => {
  try { await step.runAction(internal.tools.execute, args, { retry: false }) }
  catch { await step.runMutation(internal.execution.failure, args) }
})
export const revise = workflow.define({ args: { actionId: v.id('actions'), revision: v.number() } }).handler(async (step, args): Promise<void> => {
  try { await step.runAction(internal.preparation.revise, args, { retry: false }) }
  catch { await step.runMutation(internal.revisions.fail, args) }
})

export const refreshWorkingMemory = workflow.define({ args: { jobId: v.id('jobs') } }).handler(async (step, args): Promise<void> => {
  await step.runAction(internal.workingMemoryWorker.refresh, args, { retry: false })
})
