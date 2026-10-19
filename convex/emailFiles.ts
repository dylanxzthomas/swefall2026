import type { QueryCtx } from './_generated/server'
import type { Doc } from './_generated/dataModel'
import { internalQuery } from './_generated/server'
import { v } from 'convex/values'

// IDs and content fingerprints are part of the exact reviewed email payload.
export async function checkedFiles(ctx: Pick<QueryCtx, 'db'>, action: Doc<'actions'>) {
  if (action.payload.kind !== 'email') return []
  const selected = action.payload.attachments ?? []
  const job = await ctx.db.get(action.jobId), source = job && await ctx.db.get(job.sourceId)
  const files: Doc<'attachments'>[] = []
  if (selected.length > 5 || new Set(selected.map((f: any) => f.id)).size !== selected.length) throw new Error('Choose each attachment once.')
  for (const selectedFile of selected) {
    const id = ctx.db.normalizeId('attachments', selectedFile.id), file = id && await ctx.db.get(id)
    if (!file || file.householdId !== action.householdId || !source?.attachmentIds?.includes(file._id) || file.status !== 'ready' || file.expiresAt <= Date.now() || file.hash !== selectedFile.hash || file.name !== selectedFile.name) throw new Error('An email attachment changed or expired. Review the files again.')
    files.push(file)
  }
  if (files.reduce((size, f) => size + f.size, 0) > 10 * 1024 * 1024) throw new Error('Email attachments exceed 10 MB.')
  return files
}
export const forAction = internalQuery({ args: { actionId: v.id('actions') }, handler: async (ctx, { actionId }) => {
  const action = await ctx.db.get(actionId)
  if (!action) throw new Error('Email unavailable.')
  return checkedFiles(ctx, action)
} })
