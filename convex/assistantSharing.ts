import { v } from 'convex/values'
import { internalMutation } from './_generated/server'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { start } from '@convex-dev/workflow'
import { sourceHash } from '../shared/daymark'
export const prepare=internalMutation({args:{householdId:v.id('households'),subject:v.string(),text:v.string(),kind:v.union(v.literal('calendar'),v.literal('email'),v.literal('pickup'))},handler:async(ctx,a):Promise<Id<'jobs'>>=>{
  const h=await ctx.db.get(a.householdId),m=await ctx.db.query('memberships').withIndex('by_subject',q=>q.eq('subject',a.subject)).unique()
  if(!h||h.deleted||m?.householdId!==h._id)throw new Error('Household access changed.')
  const sourceId=await ctx.db.insert('sources',{householdId:h._id,text:a.text,hash:`reviewed:${sourceHash(a.text)}`,attachmentIds:[],revision:1,expiresAt:Date.now()+30*86400000})
  const jobId=await ctx.db.insert('jobs',{householdId:h._id,createdBy:a.subject,sourceId,reviewedDraftKind:a.kind,preparing:true,cancelled:false,clarification:''})
  await start(ctx,internal.workflows.prepare,{jobId,sourceRevision:1});return jobId
}})
