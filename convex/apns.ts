'use node'
import { connect } from 'node:http2'
import { sign } from 'node:crypto'
import { v } from 'convex/values'
import { internalAction } from './_generated/server'
import { internal } from './_generated/api'
import { hash } from '../shared/daymark'
export function providerToken(now: number) {
  if (!process.env.APNS_KEY_ID || !process.env.APNS_TEAM_ID || !process.env.APNS_PRIVATE_KEY) throw new Error('APNs is disconnected.')
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
  const unsigned = `${encode({ alg: 'ES256', kid: process.env.APNS_KEY_ID })}.${encode({ iss: process.env.APNS_TEAM_ID, iat: Math.floor(now / 1000) })}`
  return `${unsigned}.${sign('sha256', Buffer.from(unsigned), { key: process.env.APNS_PRIVATE_KEY.replace(/\\n/g, '\n'), dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
}
async function sendOne(token: string, authorization: string, collapse: string, jobId: string, kind: string) {
  const host = process.env.APNS_ENVIRONMENT === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com'
  return new Promise<number>((resolve, reject) => {
    const client = connect(host); let done = false
    const finish = (status?: number, error?: Error) => { if (done) return; done = true; client.destroy(); if (error) reject(error); else resolve(status ?? 0) }
    client.on('error', error => finish(undefined, error)); client.setTimeout(15000, () => finish(undefined, new Error('APNs timeout')))
    const request = client.request({ ':method': 'POST', ':path': `/3/device/${token}`, authorization: `bearer ${authorization}`, 'apns-topic': 'com.dylanxzthomas.wren', 'apns-push-type': 'alert', 'apns-priority': '5', 'apns-expiration': String(Math.floor(Date.now() / 1000) + 3600), 'apns-collapse-id': collapse })
    let status = 0
    request.on('response', headers => { status = Number(headers[':status']) }); request.on('data', () => {}); request.on('error', error => finish(undefined, error)); request.on('end', () => finish(status))
    request.end(JSON.stringify({ aps: { alert: { title: 'Daymark', body: kind === 'ready' ? 'Your requested work is ready to review.' : 'A request needs your attention.' }, sound: 'default' }, jobId }))
  })
}
export const send = internalAction({ args: { id: v.id('notifications') }, handler: async (ctx, args): Promise<void> => {
  const notice = await ctx.runMutation(internal.notifications.claim, args)
  if (!notice) return
  let accepted = false; const invalidTokens: string[] = []
  try {
    const authorization = providerToken(Date.now())
    for (const token of notice.tokens) { try { const status = await sendOne(token, authorization, hash(notice.jobId), notice.jobId, notice.kind); if (status === 200) accepted = true; if (status === 410) invalidTokens.push(token) } catch { /* No automatic duplicate alert after an ambiguous result. */ } }
  } finally { await ctx.runMutation(internal.notifications.finished, { ...args, accepted, invalidTokens }) }
} })
