'use node'
import { v } from 'convex/values'
import { Webhook } from 'svix'
import { createHash } from 'node:crypto'
import { internalAction } from './_generated/server'
import { internal } from './_generated/api'
import { validateDocument } from './files'
import type { Id } from './_generated/dataModel'
export function verifiedWebhook(raw: string, id: string, timestamp: string, signature: string, secret: string) {
  new Webhook(secret).verify(raw, { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': signature })
  return JSON.parse(raw) as { type: string; data: { email_id: string; to: string[] } }
}
export const receive = internalAction({ args: { raw: v.string(), id: v.string(), timestamp: v.string(), signature: v.string() }, handler: async (ctx, args): Promise<boolean> => {
  if (!process.env.RESEND_WEBHOOK_SECRET || args.raw.length > 100000) return false
  let event
  try { event = verifiedWebhook(args.raw, args.id, args.timestamp, args.signature, process.env.RESEND_WEBHOOK_SECRET) } catch { return false }
  if (event.type !== 'email.received') return true
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(event.data?.email_id) || !Array.isArray(event.data.to) || event.data.to.some(to => typeof to !== 'string')) return false
  await ctx.runMutation(internal.inbound.received, { to: event.data.to, providerId: event.data.email_id })
  return true
} })
export const senderAuthenticated = (email: any, allowed: string) => {
  const from = String(email.from ?? '').trim().match(/^(?:[^<>]*<)?([^<>\s]+@[^<>\s]+)>?$/)?.[1]?.toLowerCase()
  return from === allowed.toLowerCase() && email.authentication?.dmarc === 'pass' && (email.authentication?.dkim === 'pass' || email.authentication?.spf === 'pass')
}
export function trustedDownload(value: string) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.hostname !== 'inbound-cdn.resend.com' || url.port || url.username || url.password) throw new Error('Attachment host was not the configured mail provider.')
  return url.toString()
}
async function limitedBytes(response: Response, max: number) {
  if (!response.ok || Number(response.headers.get('content-length')) > max || !response.body) throw new Error('Notice or attachment exceeds supported limits.')
  const reader = response.body.getReader(), parts: Uint8Array[] = []; let size = 0
  while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > max) { await reader.cancel(); throw new Error('Notice or attachment exceeds supported limits.') } parts.push(value) }
  return Buffer.concat(parts)
}
async function provider(path: string) {
  if (!process.env.RESEND_API_KEY) throw new Error('Inbound service is disconnected.')
  const response = await fetch(`https://api.resend.com/emails/receiving/${path}`, { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` }, signal: AbortSignal.timeout(15000), redirect: 'error' })
  return JSON.parse((await limitedBytes(response, 500000)).toString())
}
export const ingest = internalAction({ args: { id: v.id('inbound') }, handler: async (ctx, { id }): Promise<void> => {
  const context = await ctx.runQuery(internal.inbound.context, { id })
  if (!context) return
  const saved: { storageId: Id<'_storage'>; name: string; size: number; mediaType: string; hash: string }[] = []
  let retained = false
  try {
    const message = await provider(`${encodeURIComponent(context.item.providerId)}?html_format=cid`)
    if (!senderAuthenticated(message, context.alias.sender)) {
      await ctx.runMutation(internal.inbound.held, { id, status: 'quarantined', reason: 'Sender identity could not be verified. Forward again from your verified sign-in email, or share the notice directly in Daymark.', sender: String(message.from ?? '').slice(0, 320), title: String(message.subject ?? '').slice(0, 300) }); return
    }
    const text = `${String(message.subject ?? '')}\n\n${String(message.text ?? message.html ?? '')}`.trim()
    if (!text || text.length > 20000) throw new Error('Notice text must be between 1 and 20,000 characters. Share the document directly.')
    const attachments = await provider(`${encodeURIComponent(context.item.providerId)}/attachments`)
    if (attachments.has_more || !Array.isArray(attachments.data) || attachments.data.length > 5 || attachments.data.some((f: any) => f.content_type === 'application/pdf') && attachments.data.length !== 1) throw new Error('Share up to five images or one PDF, 10 MB total.')
    let total = 0
    for (const file of attachments.data) {
      const bytes = await limitedBytes(await fetch(trustedDownload(file.download_url), { signal: AbortSignal.timeout(15000), redirect: 'error' }), 10 * 1024 * 1024 - total)
      total += bytes.length
      const checked = await validateDocument(bytes), data = Buffer.from(checked.data)
      if (data.length > 10 * 1024 * 1024) throw new Error('Converted image exceeds 10 MB.')
      const storageId = await ctx.storage.store(new Blob([data], { type: checked.mediaType }))
      saved.push({ storageId, name: String(file.filename ?? 'Shared document').replace(/[\r\n\x00]/g, '').slice(0, 200), size: data.length, mediaType: checked.mediaType, hash: createHash('sha256').update(data).digest('hex') })
    }
    if (saved.reduce((n, f) => n + f.size, 0) > 10 * 1024 * 1024) throw new Error('Converted attachments exceed 10 MB.')
    retained = await ctx.runMutation(internal.inbound.commit, { id, text, files: saved, sender: context.alias.sender, title: String(message.subject ?? '').slice(0, 300) })
  } catch (e) { await ctx.runMutation(internal.inbound.held, { id, status: 'failed', reason: /Share|Notice|Converted|Inbound/.test((e as Error).message) ? (e as Error).message : 'The forwarded notice could not be retrieved. Retry or share it directly; nothing was prepared or sent.' }) }
  finally { if (!retained) for (const file of saved) await ctx.storage.delete(file.storageId) }
} })
