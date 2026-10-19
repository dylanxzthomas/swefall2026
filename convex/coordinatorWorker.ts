'use node'
import { randomBytes } from 'node:crypto'
import { APIConnectionError } from '@anthropic-ai/sdk'
import { v } from 'convex/values'
import { internalAction } from './_generated/server'
import { internal } from './_generated/api'
import { extractStructured } from '../server/model'
import { coordinatorPrompt, coordinatorStep } from '../shared/assistantCoordinator'
import { extractionSchema } from '../shared/daymark'
import { preparationPrompt } from '../shared/preparation'
export function modelFailure(error: unknown) {
  const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' && Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : undefined
  const name = error instanceof Error ? error.name : ''
  // Retry only a recognized provider/transport failure. Unknown exceptions,
  // missing configuration and invalid output must not create a retry loop.
  const transient = status === 408 || status === 429 || !!status && status >= 500 || !status && error instanceof APIConnectionError
  return { failureCode: status === 429 ? 'model_quota' as const : status && status < 500 ? 'model_request' as const : /Zod|Validation|Parse/.test(name) ? 'model_output' as const : 'model_unavailable' as const, ...(status ? { failureStatus: status } : {}), transient }
}
export const step = internalAction({ args: { id: v.id('assistantRuns'), version: v.number() }, handler: async (ctx, a): Promise<void> => {
  const lease = { ...a, lease: randomBytes(20).toString('hex') }, input = await ctx.runMutation(internal.assistantCoordinator.claim, lease)
  if (!input) return
  let result: unknown
  try { result = await extractStructured(coordinatorStep, coordinatorPrompt, input, [], undefined, input.assistant?.history, { maxTokens: 4000, timeoutMs: 60000 }) }
  catch(error) { await ctx.runMutation(internal.assistantCoordinator.fail, {...lease,...modelFailure(error)}); return }
  try {
    const saved = await ctx.runMutation(internal.assistantCoordinator.commitStep, { ...lease, result: JSON.stringify(result) })
    if (saved.correction) {
      if (!await ctx.runMutation(internal.assistantCoordinator.correct, { ...lease, reason: saved.correction })) await ctx.runMutation(internal.assistantCoordinator.fail, { ...lease, failureCode: 'model_output' })
    } else if (saved.failureCode) await ctx.runMutation(internal.assistantCoordinator.fail, { ...lease, failureCode: saved.failureCode })
  } catch { await ctx.runMutation(internal.assistantCoordinator.fail, { ...lease, failureCode: 'backend_failure' }) }
} })
export const prepareNotice = internalAction({ args: { id: v.id('assistantRuns'), version: v.number() }, handler: async (ctx, a): Promise<void> => {
  const lease = { ...a, lease: randomBytes(20).toString('hex') }, claim = await ctx.runMutation(internal.assistantCoordinator.claim, { ...lease, phase: 'notice' })
  if (!claim) return
  let input: unknown
  try { input = await ctx.runMutation(internal.assistantCoordinator.noticeInput, lease) }
  catch { await ctx.runMutation(internal.assistantCoordinator.fail, { ...lease, failureCode: 'backend_failure' }); return }
  if (!input) return
  let result: unknown
  try { result = await extractStructured(extractionSchema, preparationPrompt, input, [], undefined, undefined, { maxTokens: 4000, timeoutMs: 60000 }) }
  catch (error) { await ctx.runMutation(internal.assistantCoordinator.fail, { ...lease, ...modelFailure(error) }); return }
  try { await ctx.runMutation(internal.assistantCoordinator.noticeFinished, { ...lease, result: JSON.stringify(result) }) }
  catch { await ctx.runMutation(internal.assistantCoordinator.fail, { ...lease, failureCode: 'backend_failure' }) }
} })
