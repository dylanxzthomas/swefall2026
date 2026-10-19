'use node'
import { randomBytes } from 'node:crypto'
import { v } from 'convex/values'
import { internalAction } from './_generated/server'
import { internal } from './_generated/api'
import { extractStructured } from '../server/model'
import { workflowCurationModelSchema, workflowCuratorPrompt } from '../shared/learnedWorkflows'
export const prepare = internalAction({ args: { id: v.id('workflowCurations'), version: v.number() }, handler: async (ctx, args): Promise<void> => {
  const lease = { ...args, lease: randomBytes(20).toString('hex') }, input = await ctx.runMutation(internal.learnedWorkflows.claim, lease)
  if (!input) return
  let stage: 'model' | 'validation' = 'model'
  try {
    const result = await extractStructured(workflowCurationModelSchema, workflowCuratorPrompt, input, [], undefined, undefined, { maxTokens: 2500, timeoutMs: 60000 })
    stage = 'validation'
    await ctx.runMutation(internal.learnedWorkflows.finish, { ...lease, result: JSON.stringify(result) })
  } catch (cause) {
    // Store only fixed categories; provider errors can contain the private source.
    const error = cause as { status?: number; message?: string }
    const failureCode = stage === 'validation' ? 'invalid_output' : /grammar/i.test(error.message ?? '') ? 'grammar_limit' : error.status === 400 ? 'request_rejected' : error.status === 429 ? 'rate_limit' : 'unavailable'
    await ctx.runMutation(internal.learnedWorkflows.failed, { ...lease, failureCode })
  }
} })
