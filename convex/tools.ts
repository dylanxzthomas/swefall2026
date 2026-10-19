import { v } from 'convex/values'
import { internalAction, internalMutation, type MutationCtx } from './_generated/server'
import { internal } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import { validate } from './execution'
import { assertToolBudget, resolveApprovedTool, validateToolGrant, type ToolDefinition, type ToolSelection } from '../shared/tools'

const args = { actionId: v.id('actions'), approvalId: v.id('approvals') }

/** Reusable by native claim paths; authorization remains in execution.validate. */
export async function checkedApprovedTool(ctx: MutationCtx, action: Doc<'actions'>, approval: Doc<'approvals'>): Promise<ToolDefinition> {
  const { tool } = resolveApprovedTool(action.payload, approval as ToolSelection)
  const connection = approval.connectionId ? await ctx.db.get(approval.connectionId) : null
  validateToolGrant(tool, connection, approval.destination, approval.nativeDeviceId)
  const attempts = await ctx.db.query('attempts').withIndex('by_action', q => q.eq('actionId', action._id)).collect()
  assertToolBudget(tool, { argumentBytes: new TextEncoder().encode(JSON.stringify(action.payload)).length, previousAttempts: attempts.filter(attempt => attempt.approvalId === approval._id).length, adapterCalls: 1 })
  return tool
}

export const preflight = internalMutation({ args, handler: async (ctx, input): Promise<{ name: string; version: 1; adapter: ToolDefinition['adapter'] } | null> => {
  const action = await ctx.db.get(input.actionId), approval = await ctx.db.get(input.approvalId)
  if (!action || !approval || action.status !== 'queued' || action.approvalId !== approval._id || approval.actionId !== action._id || approval.householdId !== action.householdId) return null
  try {
    const tool = await checkedApprovedTool(ctx, action, approval)
    const issue = await validate(ctx, action, approval)
    if (issue) throw new Error(issue)
    return { name: tool.name, version: tool.version, adapter: tool.adapter }
  } catch (error) {
    // Rejection occurs before reserving or dispatching an external operation.
    await ctx.db.patch(action._id, { status: 'review', approvalId: undefined, error: error instanceof Error && error.name !== 'ZodError' ? error.message : 'This tool received unsupported action details. Review the request again.' })
    return null
  }
} })

export const execute = internalAction({ args, handler: async (ctx, input): Promise<void> => {
  const tool = await ctx.runMutation(internal.tools.preflight, input)
  if (!tool || tool.adapter === 'approved_native_calendar') return // Remains queued for its authorized iPhone.
  if (tool.adapter !== 'approved_provider_action') throw new Error('This tool has no approved server adapter.')
  // Exactly one vetted adapter call. Its claim/dispatch mutations recheck the approval
  // after preflight; its attempts and provider receipts remain completion authority.
  await ctx.runAction(internal.google.execute, input)
} })
