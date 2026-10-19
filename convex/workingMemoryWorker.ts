'use node'
import { randomUUID } from 'node:crypto'
import { v } from 'convex/values'
import { internalAction } from './_generated/server'
import { internal } from './_generated/api'
import { workingMemorySchema, workingMemoryPrompt } from '../shared/workingMemory'
import { extractStructured, workingMemoryBudget, type ModelUsage } from '../server/model'
import type { Id } from './_generated/dataModel'
export const refresh = internalAction({ args: { jobId: v.id('jobs') }, handler: async (ctx, args): Promise<void> => {
  const lease = await ctx.runMutation(internal.workingMemory.claim, { ...args, lease: randomUUID() })
  if (!lease) return
  try {
    let metrics: ModelUsage | undefined
    const result = workingMemorySchema.parse(await extractStructured(workingMemorySchema, workingMemoryPrompt, { requests: lease.requests }, [], usage => { metrics = usage }, undefined, workingMemoryBudget))
    const ok = await ctx.runMutation(internal.workingMemory.finish, { id: lease.id, inputKey: lease.inputKey, lease: lease.lease, context: lease.context, ...(metrics ? { metrics } : {}), notes: result.notes.map(n => ({ jobId: n.jobId as Id<'jobs'>, quote: n.quote })) })
    if (!ok) await ctx.runMutation(internal.workingMemory.failed, { id: lease.id, inputKey: lease.inputKey, lease: lease.lease })
  } catch { await ctx.runMutation(internal.workingMemory.failed, { id: lease.id, inputKey: lease.inputKey, lease: lease.lease }) }
} })
