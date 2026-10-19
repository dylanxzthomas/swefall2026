'use node'
import { randomBytes } from 'node:crypto'
import { v } from 'convex/values'
import { internalAction } from './_generated/server'
import { internal } from './_generated/api'
import { extractStructured } from '../server/model'
import { mailAgentPrompt, mailAgentStepSchema } from '../shared/mailFollowthrough'
export const step = internalAction({ args: { id: v.id('mailAgents'), version: v.number() }, handler: async (ctx, args): Promise<void> => {
  const lease = { ...args, lease: randomBytes(20).toString('hex') }
  const input = await ctx.runMutation(internal.mailFollowthrough.claim, lease)
  if (!input) return
  let stage: 'model' | 'validation' = 'model'
  try {
    const result = await extractStructured(mailAgentStepSchema, mailAgentPrompt, input, [], undefined, undefined, { maxTokens: 3500, timeoutMs: 60000 })
    stage = 'validation'
    const saved = await ctx.runMutation(internal.mailFollowthrough.commitStep, { ...lease, result: JSON.stringify(result) })
    if (saved.code) {
      const repairing = ['source_evidence', 'proposal_fields'].includes(saved.code) && await ctx.runMutation(internal.mailFollowthrough.repair, { ...lease, code: saved.code })
      if (!repairing) await ctx.runMutation(internal.mailFollowthrough.failed, { ...lease, stage, code: saved.code })
    }
  } catch (e) {
    const error = e as { status?: number; message?: string }
    // Fixed categories only: provider/model exceptions can contain request text.
    const validationCode = /verified evidence|verified sources|unique, verified|supplied private source/i.test(error.message ?? '') ? 'source_evidence' : /valid date|valid time|timezone|missing calendar|reply text|Combine related|already used|read step|Finish within|eligible routine/i.test(error.message ?? '') ? 'proposal_fields' : /newer thread/i.test(error.message ?? '') ? 'stale_thread' : /sources changed before/i.test(error.message ?? '') ? 'summary_changed' : 'backend_failure'
    const code = stage === 'validation' ? validationCode : /grammar/i.test(error.message ?? '') ? 'grammar_limit' : error.status === 400 ? 'request_rejected' : error.status === 429 ? 'rate_limit' : 'unavailable'
    await ctx.runMutation(internal.mailFollowthrough.failed, { ...lease, stage, code })
  }
} })
