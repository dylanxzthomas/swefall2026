'use node'
import { v } from 'convex/values'
import { internalAction } from './_generated/server'
import { internal } from './_generated/api'
// The ID is captured from the authenticated identity at deletion approval, never supplied by the client.
export async function deleteIdentity(userId: string) {
  const issuer = new URL(process.env.AUTH0_DOMAIN ?? '')
  if (issuer.protocol !== 'https:' || issuer.pathname !== '/' || issuer.username || issuer.password || issuer.port) throw new Error('Invalid Auth0 issuer configuration.')
  const root = issuer.origin
  if (!process.env.AUTH0_MANAGEMENT_CLIENT_ID || !process.env.AUTH0_MANAGEMENT_CLIENT_SECRET) throw new Error('Identity deletion is not configured.')
  const response = await fetch(`${root}/oauth/token`, { method: 'POST', signal: AbortSignal.timeout(15000), redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'client_credentials', client_id: process.env.AUTH0_MANAGEMENT_CLIENT_ID, client_secret: process.env.AUTH0_MANAGEMENT_CLIENT_SECRET, audience: `${root}/api/v2/`, scope: 'delete:users' }) })
  if (!response.ok) throw new Error('Identity service unavailable.')
  const token = await response.json() as { access_token?: string }
  if (!token.access_token) throw new Error('Identity service unavailable.')
  const removed = await fetch(`${root}/api/v2/users/${encodeURIComponent(userId)}`, { method: 'DELETE', signal: AbortSignal.timeout(15000), redirect: 'error', headers: { Authorization: `Bearer ${token.access_token}` } })
  if (removed.status !== 204 && removed.status !== 404) throw new Error('Identity deletion unconfirmed.')
}
export const remove = internalAction({ args: { jobId: v.id('deletionJobs') }, handler: async (ctx, args): Promise<void> => {
  const job = await ctx.runQuery(internal.privacy.deletionContext, args)
  if (!job || job.identityStatus === 'deleted' || !job.auth0UserId) return
  if (!process.env.AUTH0_MANAGEMENT_CLIENT_ID || !process.env.AUTH0_MANAGEMENT_CLIENT_SECRET || process.env.DAYMARK_ENVIRONMENT !== 'production' && !(process.env.DAYMARK_TEST_AUTH0_SUBJECTS ?? '').split(',').map(s => s.trim()).includes(job.auth0UserId)) {
    await ctx.runMutation(internal.privacy.identityResult, { ...args, status: 'needs_configuration' }); return
  }
  try { await deleteIdentity(job.auth0UserId); await ctx.runMutation(internal.privacy.identityResult, { ...args, status: 'deleted' }) }
  catch { await ctx.runMutation(internal.privacy.identityResult, { ...args, status: 'retry_pending' }) }
} })
