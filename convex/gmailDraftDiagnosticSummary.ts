'use node'
import type { gmail_v1 } from '@googleapis/gmail'
import { extractGmailMessage, type GmailPart } from '../shared/gmailMessage'
import { decodeGmailSubject } from '../shared/gmailReply'
import { exactSender } from '../shared/emailWatches'
import { simplePlainHtmlMatches } from '../shared/gmailDraftForm'
import type { Approved } from './gmailDrafts'

type HeaderMap = Map<string, string[]>
const opaqueId = (id: unknown): id is string => typeof id === 'string' && /^[^\s\u0000-\u001f\u007f]{1,200}$/u.test(id)
const lines = (value: string) => value.replace(/\r\n|\r/g, '\n')
const withoutTerminalLineBreaks = (value: string) => lines(value).replace(/[\r\n]+$/, '')
function decodedPartText(part: GmailPart): string | null {
  const data = part.body?.data
  if (part.filename || part.body?.attachmentId || typeof data !== 'string' || data.length > 200_000 || !/^[A-Za-z0-9_-]*={0,2}$/.test(data)) return null
  try {
    const bytes = Buffer.from(data, 'base64url')
    if (bytes.toString('base64url') !== data.replace(/=+$/, '') || part.body?.size !== undefined && part.body.size !== null && part.body.size !== bytes.length) return null
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch { return null }
}
const one = (headers: HeaderMap, name: string) => headers.get(name)?.length === 1 ? headers.get(name)![0] : undefined
function rawHeaders(raw: string | null | undefined): HeaderMap | null {
  if (!raw || raw.length > 200_000 || !/^[A-Za-z0-9_-]+={0,2}$/.test(raw)) return null
  try {
    const mime = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(raw, 'base64url')), boundary = mime.indexOf('\r\n\r\n')
    if (boundary < 0) return null
    const headers: HeaderMap = new Map()
    for (const line of mime.slice(0, boundary).replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
      const colon = line.indexOf(':'), name = line.slice(0, colon).toLowerCase()
      if (colon < 1 || !/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) return null
      const values = headers.get(name) ?? []; values.push(line.slice(colon + 1).trim()); headers.set(name, values)
    }
    return headers
  } catch { return null }
}
const marker = (headers: HeaderMap, name: string, previous: string, pending: string) => ({ count: !headers.has(name) ? 'missing' : headers.get(name)!.length === 1 ? 'single' : 'duplicate', matchesPrevious: one(headers, name) === previous, matchesPending: one(headers, name) === pending })
const mimeCategory = (value: string) => ['text/plain', 'text/html', 'multipart/alternative', 'multipart/mixed', 'multipart/related'].includes(value) ? value : 'other'
const encodingCategory = (value: string) => ['base64', 'quoted-printable', '7bit', '8bit'].includes(value) ? value : 'other'
const matchesThread = (draft: gmail_v1.Schema$Draft, proof: Approved) => proof.replyRouting ? draft.message?.threadId === proof.replyRouting.threadId : null

/** Diagnostic comparisons only. Extraction normalizes text and must never authorize a write. */
export function draftDiagnosticSummary(raw: gmail_v1.Schema$Draft, full: gmail_v1.Schema$Draft, expectedId: string, previous: Approved, pending: Approved, strict: { previous: string | null; pending: string | null }) {
  const headers = rawHeaders(raw.message?.raw), payload = full.message?.payload
  const extraction = extractGmailMessage({ payload }), expectedExtraction = (proof: Approved) => extractGmailMessage({ payload: { mimeType: 'text/plain', body: { data: Buffer.from(proof.input.body).toString('base64url') } } }).text
  let parts = 0, bounded = false
  const html: ReturnType<typeof extractGmailMessage>[] = []
  const htmlSource: (string | null)[] = []
  const plain: string[] = []
  const walk = (part: GmailPart, depth: number) => {
    if (++parts > 100 || depth > 12) { bounded = true; return }
    const type = (part.mimeType ?? '').toLowerCase()
    // Parse each HTML alternative explicitly: the ordinary extractor can prefer
    // plain text and skip HTML. These lossy comparisons never authorize a write.
    if (type === 'text/html') { html.push(extractGmailMessage({ payload: part })); htmlSource.push(decodedPartText(part)) }
    if (type === 'text/plain' && !part.filename && !part.body?.attachmentId && typeof part.body?.data === 'string') {
      const checked = extractGmailMessage({ payload: part })
      if (checked.incomplete || checked.truncated) bounded = true
      else { const decoded = decodedPartText(part); if (decoded === null) bounded = true; else plain.push(decoded) }
    }
    for (const child of (part.parts ?? []).slice(0, 100)) { if (parts >= 100) { bounded = true; break }; walk(child, depth + 1) }
    if ((part.parts?.length ?? 0) > 100) bounded = true
  }
  if (payload) walk(payload, 0)
  const compare = (proof: Approved) => ({
    sender: headers ? exactSender(one(headers, 'from') ?? '') === proof.accountEmail.toLowerCase() : null,
    recipient: headers ? one(headers, 'to') === proof.input.to : null,
    subject: headers ? decodeGmailSubject(one(headers, 'subject') ?? '') === proof.input.subject : null,
    replyParent: headers ? proof.replyRouting ? one(headers, 'in-reply-to') === proof.replyRouting.inReplyTo : !headers.has('in-reply-to') : null,
    replyReferences: headers ? proof.replyRouting ? one(headers, 'references')?.split(/[ \t]+/).join(' ') === proof.replyRouting.references.join(' ') : !headers.has('references') : null,
    plainBodyExact: !bounded && plain.length === 1 ? lines(plain[0]) === lines(proof.input.body) : null,
    plainBodyIgnoringTerminalLineBreaksMatches: !bounded && plain.length === 1 ? withoutTerminalLineBreaks(plain[0]) === withoutTerminalLineBreaks(proof.input.body) : null,
    htmlVisibleTextMatches: !bounded && html.length === 1 && !html[0].incomplete && !html[0].truncated ? html[0].text === expectedExtraction(proof) : null,
    htmlSimplePlainRepresentationMatches: !bounded && !extraction.incomplete && !extraction.truncated && html.length === 1 && !html[0].incomplete && !html[0].truncated && htmlSource[0] !== null ? simplePlainHtmlMatches(htmlSource[0], proof.input.body) : false,
    extractedTextMatches: !extraction.incomplete && !extraction.truncated ? extraction.text === expectedExtraction(proof) : null,
  })
  return {
    diagnosticOnly: true as const,
    draftIdentity: { raw: raw.id === expectedId, full: full.id === expectedId },
    crossReadMessageIdentity: opaqueId(raw.message?.id) && raw.message.id === full.message?.id,
    draftLabels: { raw: raw.message?.labelIds?.includes('DRAFT') === true && !raw.message.labelIds.includes('SENT'), full: full.message?.labelIds?.includes('DRAFT') === true && !full.message.labelIds.includes('SENT') },
    thread: { previous: matchesThread(raw, previous), pending: matchesThread(raw, pending), crossRead: typeof raw.message?.threadId === 'string' && raw.message.threadId === full.message?.threadId },
    markers: headers ? { operation: marker(headers, 'x-daymark-draft-operation', previous.operationKey, pending.operationKey), approval: marker(headers, 'x-daymark-draft-hash', previous.approvedHash, pending.approvedHash) } : null,
    strict,
    previous: compare(previous), pending: compare(pending),
    mime: { rawHeadersReadable: !!headers, type: mimeCategory((one(headers ?? new Map(), 'content-type') ?? '').split(';')[0].trim().toLowerCase()), encoding: encodingCategory((one(headers ?? new Map(), 'content-transfer-encoding') ?? '').toLowerCase()), htmlPartPresent: html.length > 0, htmlPartCount: html.length, htmlExtractionIncomplete: bounded || html.some(part => part.incomplete || part.truncated), plainPartCount: Math.min(plain.length, 100), structureBounded: bounded },
    additionalRecipientHeaders: headers ? headers.has('cc') || headers.has('bcc') || [...headers.keys()].some(name => name.startsWith('resent-')) || (headers.get('to')?.length ?? 0) > 1 : null,
    extraction: { format: extraction.format, complete: !!payload && !extraction.incomplete && !extraction.truncated && !bounded, unreadAttachments: extraction.attachments, issuesPresent: extraction.issues.length > 0 },
  }
}
