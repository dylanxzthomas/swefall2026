import { z } from 'zod'
import { hash } from './daymark.js'
import { privateReplySchema, type PrivateReplyInput } from './mailbox.js'

// A conservative RFC 5322 msg-id subset: no comments, quoted locals or header controls.
// Unsupported source headers remain readable but never become outgoing routing headers.
const atom = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+"
const messageIdPattern = new RegExp(`^<${atom}(?:\\.${atom})*@${atom}(?:\\.${atom})*>$`)
export const rfcMessageIdSchema = z.string().max(254).regex(messageIdPattern)
export const gmailReplyRoutingSchema = z.object({
  threadId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
  inReplyTo: rfcMessageIdSchema,
  references: z.array(rfcMessageIdSchema).min(1).max(50),
  subject: z.string().trim().min(1).max(300).regex(/^[^\r\n\u0000-\u001f\u007f]+$/),
}).strict().refine(value => value.references.at(-1) === value.inReplyTo && new Set(value.references).size === value.references.length, 'Invalid reply references.')
export type GmailReplyRouting = z.infer<typeof gmailReplyRoutingSchema>
export const gmailReplySubject = (subject: string) => (/^re:/i.test(subject) ? subject : `Re: ${subject}`).replace(/[\r\n]+/g, ' ').slice(0, 300).trim() || 'Re: Your message'

/** Gmail payload headers may still contain RFC 2047 encoded words. Decode only supported, valid bytes. */
export function decodeGmailSubject(value: string): string | undefined {
  const unfolded = value.replace(/\r\n[ \t]+/g, ' ').replace(/\t/g, ' ').trim()
  if (unfolded.length > 4096 || /[\u0000-\u001f\u007f]/.test(unfolded)) return undefined
  if (!unfolded.includes('=?')) return unfolded
  try {
    const adjacent = unfolded.replace(/(=\?[^?\s]+\?[bq]\?[^?\s]+\?=)[ \t]+(?==\?)/gi, '$1')
    const decoded = adjacent.replace(/=\?([^?\s]+)\?([bq])\?([^?\s]+)\?=/gi, (_word, charset: string, encoding: string, content: string) => {
      if (!['utf-8', 'us-ascii'].includes(charset.toLowerCase())) throw new Error('Unsupported subject charset.')
      if (/[^\x21-\x7e]/.test(content)) throw new Error('Invalid subject encoding.')
      let bytes: Uint8Array
      if (encoding.toLowerCase() === 'b') {
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(content)) throw new Error('Invalid subject encoding.')
        bytes = Uint8Array.from(atob(content), c => c.charCodeAt(0))
      } else {
        const data: number[] = []
        for (let i = 0; i < content.length; i++) {
          if (content[i] === '=') {
            if (!/^[a-f0-9]{2}$/i.test(content.slice(i + 1, i + 3))) throw new Error('Invalid subject encoding.')
            data.push(Number.parseInt(content.slice(i + 1, i + 3), 16)); i += 2
          } else data.push(content[i] === '_' ? 32 : content.charCodeAt(i))
        }
        bytes = Uint8Array.from(data)
      }
      if (charset.toLowerCase() === 'us-ascii' && bytes.some(byte => byte > 127)) throw new Error('Invalid subject bytes.')
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    })
    return decoded.includes('=?') || /[\u0000-\u001f\u007f]/.test(decoded) ? undefined : decoded
  } catch { return undefined }
}

/** Derive routing only from the account-bound provider message's top-level headers. */
export function gmailReplyRouting(message: { threadId?: string | null; payload?: { headers?: { name?: string | null; value?: string | null }[] | null } | null }): GmailReplyRouting | undefined {
  const headers = message.payload?.headers ?? []
  const one = (name: string) => {
    const matches = headers.filter(h => h.name?.toLowerCase() === name)
    if (matches.length !== 1 || !matches[0].value) return undefined
    const value = matches[0].value.replace(/\r\n[ \t]+/g, ' ').replace(/\t/g, ' ').trim()
    return /[\u0000-\u001f\u007f]/.test(value) ? undefined : value
  }
  const inReplyTo = one('message-id'), subject = decodeGmailSubject(one('subject') ?? '')
  if (!inReplyTo || !subject || subject.length > 296 && !/^re:/i.test(subject)) return undefined
  const refs = headers.filter(h => h.name?.toLowerCase() === 'references')
  if (refs.length > 1) return undefined
  const rawReferences = refs.length ? one('references') : undefined
  if (refs.length && (!rawReferences || rawReferences.length > 12800)) return undefined
  const parentReply = one('in-reply-to')
  const references = rawReferences ? rawReferences.split(/ +/) : parentReply && rfcMessageIdSchema.safeParse(parentReply).success ? [parentReply] : []
  if (references.some(value => !rfcMessageIdSchema.safeParse(value).success) || references.length > 49) return undefined
  // Some senders already include their own ID; preserve one canonical chain.
  const result = gmailReplyRoutingSchema.safeParse({ threadId: message.threadId, inReplyTo, references: [...new Set([...references.filter(id => id !== inReplyTo), inReplyTo])], subject: gmailReplySubject(subject) })
  return result.success ? result.data : undefined
}

/** Legacy standalone approvals keep their original digest. New routing is immutable approved content. */
export function gmailReplyHash(input: PrivateReplyInput, replyRouting?: GmailReplyRouting) {
  const clean = privateReplySchema.parse(input)
  if (!replyRouting) return hash(JSON.stringify(clean))
  const route = gmailReplyRoutingSchema.parse(replyRouting)
  if (clean.subject !== route.subject) throw new Error('Keep the original reply subject to reply in this Gmail conversation.')
  return hash(JSON.stringify({ input: clean, replyRouting: route }))
}
