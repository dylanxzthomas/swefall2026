'use node'
import type { gmail_v1 } from '@googleapis/gmail'
import { exactSender } from '../shared/emailWatches'
import { decodeGmailSubject } from '../shared/gmailReply'
import { plainDraftBodyMatches, simplePlainHtmlMatches } from '../shared/gmailDraftForm'
import type { Approved } from './gmailDrafts'

type Headers = Map<string, string>
const opaque = (id: unknown): id is string => typeof id === 'string' && /^[^\s\u0000-\u001f\u007f]{1,200}$/u.test(id)
function uniqueHeaders(values: gmail_v1.Schema$MessagePartHeader[] | null | undefined): Headers | null {
  if (!values || values.length > 100) return null
  const result: Headers = new Map()
  for (const item of values) {
    const name = item.name?.toLowerCase(), value = item.value
    if (!name || !/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name) || typeof value !== 'string' || result.has(name)) return null
    const unfolded = value.replace(/\r\n[ \t]+/g, ' ')
    if (/[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(unfolded)) return null
    result.set(name, unfolded.trim())
  }
  return result
}
function rawHeaders(raw: string | null | undefined): Headers | null {
  if (!raw || raw.length > 200_000 || !/^[A-Za-z0-9_-]+={0,2}$/.test(raw)) return null
  try {
    const bytes = Buffer.from(raw, 'base64url')
    if (bytes.toString('base64url') !== raw.replace(/=+$/, '')) return null
    const mime = new TextDecoder('utf-8', { fatal: true }).decode(bytes), end = mime.indexOf('\r\n\r\n')
    if (end < 0) return null
    const entries = mime.slice(0, end).replace(/\r\n[ \t]+/g, ' ').split('\r\n').map(line => {
      const at = line.indexOf(':'); return { name: at > 0 ? line.slice(0, at) : '', value: line.slice(at + 1).trim() }
    })
    return uniqueHeaders(entries)
  } catch { return null }
}
function alternative(headers: Headers): boolean {
  return /^multipart\/alternative;\s*boundary=(?:"[a-z0-9'()+_,.\/:=? -]{1,70}"|[a-z0-9'()+_,.\/:=?-]{1,70})$/i.test(headers.get('content-type') ?? '') && headers.get('mime-version') === '1.0' && !headers.has('content-transfer-encoding') && !headers.has('content-disposition')
}
function metadata(d: gmail_v1.Schema$Draft, a: Approved, id: string): boolean {
  return d.id === id && opaque(d.message?.id) && d.message.labelIds?.includes('DRAFT') === true && !d.message.labelIds.includes('SENT') && !!a.replyRouting && d.message.threadId === a.replyRouting.threadId
}
function routing(headers: Headers, a: Approved): boolean {
  return !headers.has('x-daymark-draft-operation') && !headers.has('x-daymark-draft-hash') && !headers.has('cc') && !headers.has('bcc') && ![...headers.keys()].some(name => name.startsWith('resent-')) && /^<[^<>\s@]+@[^<>\s@]+>$/.test(headers.get('message-id') ?? '') && exactSender(headers.get('from') ?? '') === a.accountEmail.toLowerCase() && headers.get('to') === a.input.to && decodeGmailSubject(headers.get('subject') ?? '') === a.input.subject && !!a.replyRouting && headers.get('in-reply-to') === a.replyRouting.inReplyTo && headers.get('references')?.split(/[ \t]+/).join(' ') === a.replyRouting.references.join(' ')
}
/** Only this narrowly recognized missing-marker form may trigger one extra known-ID read. */
export function normalizedPreimageCandidate(raw: gmail_v1.Schema$Draft, a: Approved, id: string): boolean {
  const headers = rawHeaders(raw.message?.raw)
  return metadata(raw, a, id) && !!headers && alternative(headers) && routing(headers, a)
}
function decodedPart(part: gmail_v1.Schema$MessagePart, type: 'text/plain' | 'text/html'): string | null {
  if (part.mimeType !== type || part.filename || part.parts?.length || part.body?.attachmentId) return null
  const headers = uniqueHeaders(part.headers)
  if (!headers || [...headers.keys()].some(name => name !== 'content-type' && name !== 'content-transfer-encoding')) return null
  const mime = headers.get('content-type') ?? ''
  if (!new RegExp(`^${type};\\s*charset=(?:"(?:utf-8|us-ascii)"|utf-8|us-ascii)$`, 'i').test(mime)) return null
  const encoding = (headers.get('content-transfer-encoding') ?? '7bit').toLowerCase()
  if (!['7bit', '8bit', 'quoted-printable', 'base64'].includes(encoding)) return null
  const data = part.body?.data, size = part.body?.size
  if (typeof data !== 'string' || data.length > 200_000 || !/^[A-Za-z0-9_-]+={0,2}$/.test(data) || !Number.isSafeInteger(size) || size! < 0) return null
  try {
    const bytes = Buffer.from(data, 'base64url')
    if (bytes.toString('base64url') !== data.replace(/=+$/, '') || bytes.length !== size || (encoding === '7bit' || /us-ascii/i.test(mime)) && bytes.some(byte => byte > 127)) return null
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch { return null }
}
/** Pre-write only. Never call from post-write receipts or ID discovery/recovery. */
export function matchesNormalizedKnownPreimage(raw: gmail_v1.Schema$Draft, full: gmail_v1.Schema$Draft, a: Approved, id: string): boolean {
  if (!normalizedPreimageCandidate(raw, a, id) || !metadata(full, a, id) || raw.message!.id !== full.message!.id || JSON.stringify(full).length > 200_000) return false
  const payload = full.message?.payload, headers = uniqueHeaders(payload?.headers)
  if (!payload || payload.mimeType !== 'multipart/alternative' || payload.filename || payload.body?.data || payload.body?.attachmentId || payload.body?.size || !headers || !alternative(headers) || !routing(headers, a) || payload.parts?.length !== 2) return false
  const plain = payload.parts.find(part => part.mimeType === 'text/plain'), html = payload.parts.find(part => part.mimeType === 'text/html')
  if (!plain || !html) return false
  const text = decodedPart(plain, 'text/plain'), markup = decodedPart(html, 'text/html')
  return text !== null && markup !== null && plainDraftBodyMatches(text, a.input.body) && simplePlainHtmlMatches(markup, a.input.body)
}
