/** A bounded text view of Gmail's parsed MIME payload. No attachment or URL is fetched. */
export type GmailPart = {
  mimeType?: string | null
  filename?: string | null
  headers?: { name?: string | null; value?: string | null }[] | null
  body?: { data?: string | null; size?: number | null; attachmentId?: string | null } | null
  parts?: GmailPart[] | null
}
export type GmailExtraction = {
  text: string
  format: 'plain' | 'html' | 'snippet' | 'unavailable'
  truncated: boolean
  incomplete: boolean
  attachments: boolean
  issues: string[]
}
export const gmailTextLimit = 16_000
const partByteLimit = 256 * 1024
const messageByteLimit = 512 * 1024
const partLimit = 100
const depthLimit = 12
type Body = Pick<GmailExtraction, 'text' | 'format' | 'truncated' | 'incomplete' | 'issues'>
const empty = (): Body => ({ text: '', format: 'unavailable', truncated: false, incomplete: false, issues: [] })
const issue = (message: string, truncated = false): Body => ({ ...empty(), incomplete: true, truncated, issues: [message] })
const unique = (items: string[]) => [...new Set(items)].slice(0, 8)
function clip(text: string, limit: number): string {
  const end = Math.min(limit, text.length)
  return text.slice(0, end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]) ? end - 1 : end)
}
function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\t\u00a0 ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}
function cleanText(text: string): { text: string; issues: string[] } {
  // Replace hidden controls with a boundary, not an empty string that could join two dates/numbers.
  const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g
  const cleaned = text.replace(controls, ' ')
  return { text: normalize(cleaned), issues: cleaned === text ? [] : ['Hidden control characters were replaced with spaces.'] }
}
function header(part: GmailPart, name: string): string {
  return (part.headers ?? []).filter(h => h.name?.toLowerCase() === name).map(h => h.value ?? '').join(';')
}
function mime(part: GmailPart): string { return (part.mimeType ?? '').toLowerCase().split(';', 1)[0].trim() }
function attached(part: GmailPart): boolean {
  return !!part.filename || /(?:^|;)\s*attachment\b|(?:^|;)\s*filename\*?\s*=/i.test(header(part, 'content-disposition'))
}

/** Reject malformed/noncanonical base64url and undecodable bytes rather than altering source facts. */
function decode(part: GmailPart, budget: { bytes: number }): { text: string } | Body {
  const body = part.body
  if (body?.attachmentId) return issue('A separately stored email body was not read.')
  const data = body?.data
  if (data == null || data === '') return body?.size ? issue('An email body section is missing.') : { text: '' }
  if (data.length > Math.ceil(partByteLimit / 3) * 4) return issue('An oversized email body section was not read.', true)
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(data)) return issue('An email body section has invalid base64url encoding.')
  const raw = data.replace(/=+$/, ''), padding = data.length - raw.length
  if (raw.length % 4 === 1 || (padding > 0 && (data.length % 4 !== 0 || padding !== (4 - raw.length % 4) % 4))) return issue('An email body section has invalid base64url encoding.')
  let bytes: Uint8Array
  try {
    const binary = atob(raw.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - raw.length % 4) % 4))
    if (btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== raw) return issue('An email body section has invalid base64url encoding.')
    bytes = Uint8Array.from(binary, c => c.charCodeAt(0))
  } catch { return issue('An email body section has invalid base64url encoding.') }
  if (bytes.length > partByteLimit || budget.bytes + bytes.length > messageByteLimit) return issue('The email exceeded the body reading limit.', true)
  budget.bytes += bytes.length
  if (body?.size != null && (!Number.isSafeInteger(body.size) || body.size < 0 || body.size !== bytes.length)) return issue('An email body section has an inconsistent byte count.')
  const contentType = `${header(part, 'content-type')};${part.mimeType ?? ''}`
  const charsets = [...contentType.matchAll(/(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]*))/gi)].map(m => (m[1] ?? m[2] ?? m[3]).trim().toLowerCase())
  if (charsets.some(c => !['utf-8', 'utf8', 'us-ascii', 'ascii'].includes(c))) return issue('An email body section uses an unsupported character encoding.')
  if (charsets.some(c => c === 'us-ascii' || c === 'ascii') && bytes.some(b => b > 127)) return issue('An email body section contains invalid ASCII text.')
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) } }
  catch { return issue('An email body section contains invalid UTF-8 text.') }
}

// Common email entities plus all valid numeric references. Unknown names remain visible and flagged.
const entities: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', bull: '•', middot: '·',
  copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', yen: '¥', cent: '¢', deg: '°', times: '×', divide: '÷',
  laquo: '«', raquo: '»', colon: ':', semi: ';', sol: '/', bsol: '\\', num: '#', commat: '@', percnt: '%',
  plus: '+', equals: '=', lpar: '(', rpar: ')', excl: '!', quest: '?', period: '.', comma: ',', Tab: '\t', NewLine: '\n',
  eacute: 'é', Eacute: 'É', egrave: 'è', Egrave: 'È', aacute: 'á', Aacute: 'Á', agrave: 'à', Agrave: 'À',
  iacute: 'í', Iacute: 'Í', oacute: 'ó', Oacute: 'Ó', uacute: 'ú', Uacute: 'Ú', ntilde: 'ñ', Ntilde: 'Ñ',
  uuml: 'ü', Uuml: 'Ü', auml: 'ä', Auml: 'Ä', ouml: 'ö', Ouml: 'Ö', ccedil: 'ç', Ccedil: 'Ç',
}
function decodeEntities(text: string, issues: Set<string>): string {
  return text.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z][a-z0-9]+);/gi, (whole, entity: string) => {
    if (entity[0] !== '#') {
      const value = entities[entity] ?? (['AMP', 'LT', 'GT', 'QUOT'].includes(entity) ? entities[entity.toLowerCase()] : undefined)
      if (value !== undefined) return value
      issues.add('Some HTML character references could not be decoded.')
      return whole
    }
    const code = entity[1].toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10)
    if (!Number.isSafeInteger(code) || code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || (code >= 0x80 && code <= 0x9f)) {
      issues.add('Some HTML character references could not be decoded.')
      return whole
    }
    return String.fromCodePoint(code)
  })
}
const hiddenStyle = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|opacity\s*:\s*0(?:\.0+)?|font-size\s*:\s*0(?:px|pt|em|rem|%)?|mso-hide\s*:\s*all)(?:\s*!important)?\s*(?:;|$)/i
function hidesContent(style: string): boolean {
  return hiddenStyle.test(style) || /(?:^|;)\s*(?:max-)?height\s*:\s*0(?:px|pt|em|rem|%)?(?:\s*!important)?\s*(?:;|$)/i.test(style) && /(?:^|;)\s*overflow(?:-y)?\s*:\s*(?:hidden|clip)(?:\s*!important)?\s*(?:;|$)/i.test(style)
}
const visibilityProperty = /(?:^|;)\s*(?:display|visibility|opacity|font-size|mso-hide|(?:max-)?height|overflow(?:-y)?)\s*:/i
function conflictingVisibility(style: string): boolean {
  const seen = new Map<string, string>()
  for (const match of style.matchAll(/(?:^|;)\s*(display|visibility|opacity|font-size|mso-hide|(?:max-)?height|overflow(?:-y)?)\s*:\s*([^;]*)/gi)) {
    const name = match[1].toLowerCase(), value = match[2].trim().toLowerCase()
    if (seen.has(name) && seen.get(name) !== value) return true
    seen.set(name, value)
  }
  return false
}
const suppressed = new Set(['head', 'title', 'script', 'style', 'template', 'noscript', 'iframe', 'object', 'embed', 'svg', 'canvas'])
const rawText = new Set(['script', 'style', 'title', 'textarea'])
const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
const blocks = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'blockquote', 'li', 'ul', 'ol', 'table', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'hr', 'pre', 'address', 'dl', 'dt', 'dd'])
type Tag = { name: string; closing: boolean; attrs: Map<string, string>; end: number }
function readTag(html: string, start: number, issues: Set<string>): Tag | null {
  const lead = /^<\s*(\/?)\s*([a-z][a-z0-9:-]*)\b/i.exec(html.slice(start, start + 100))
  if (!lead) return null
  let end = start + lead[0].length, quote = ''
  for (; end < html.length && end - start <= 8192; end++) {
    const c = html[end]
    if (quote) { if (c === quote) quote = ''; continue }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '>') break
  }
  if (end >= html.length || end - start > 8192) {
    issues.add('Malformed or oversized HTML markup was not read.')
    return { name: 'unreadable', closing: false, attrs: new Map(), end: html.length }
  }
  const attrs = new Map<string, string>()
  const source = html.slice(start + lead[0].length, end)
  for (const match of source.matchAll(/([^\s=<>\/'"]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    const key = match[1].toLowerCase()
    if (!attrs.has(key)) attrs.set(key, decodeEntities(match[2] ?? match[3] ?? match[4] ?? '', issues))
  }
  return { name: lead[2].toLowerCase(), closing: !!lead[1], attrs, end: end + 1 }
}
function htmlText(html: string): Body {
  const issues = new Set<string>(), hiddenSelectors = new Set<string>(), otherVisibilitySelectors = new Set<string>()
  // Only simple selectors are interpreted. We do not execute CSS or claim browser-equivalent rendering.
  for (const style of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    const css = style[1].replace(/\/\*[\s\S]*?\*\//g, '')
    if (css.includes('\\') || /@(?:media|supports|container|import|keyframes)\b/i.test(css)) issues.add('Some HTML styling could not be interpreted.')
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!visibilityProperty.test(rule[2])) continue
      if (conflictingVisibility(rule[2])) issues.add('Some conflicting HTML visibility could not be interpreted.')
      const selectors = hidesContent(rule[2]) ? hiddenSelectors : otherVisibilitySelectors
      for (const selector of rule[1].split(',')) {
        if (/^[.#][a-z_][\w-]*$/i.test(selector.trim()) && selectors.size < 100) selectors.add(selector.trim())
        else if (hidesContent(rule[2])) issues.add('Some hidden HTML styling could not be interpreted.')
      }
    }
  }
  const stack: { name: string; hidden: boolean }[] = [], chunks: string[] = []
  let offset = 0, tokens = 0, length = 0, truncated = false
  const emit = (text: string) => {
    if (length > gmailTextLimit * 8) { truncated = true; return }
    chunks.push(text); length += text.length
  }
  while (offset < html.length) {
    if (++tokens > 20_000) { issues.add('The HTML exceeded the reading limit.'); truncated = true; break }
    if (html.startsWith('<!--', offset)) {
      const end = html.indexOf('-->', offset + 4)
      if (end < 0) { issues.add('An unfinished HTML comment was not read.'); break }
      offset = end + 3; continue
    }
    if (/^<!|^<\?/.test(html.slice(offset, offset + 2))) {
      const end = html.indexOf('>', offset + 2)
      if (end < 0) { issues.add('Unfinished HTML markup was not read.'); break }
      offset = end + 1; continue
    }
    const tag = html[offset] === '<' ? readTag(html, offset, issues) : null
    if (!tag) {
      const end = html.indexOf('<', offset + 1)
      if (!stack.at(-1)?.hidden) emit(decodeEntities(html.slice(offset, end < 0 ? undefined : end), issues))
      offset = end < 0 ? html.length : end; continue
    }
    offset = tag.end
    if (tag.name === 'unreadable') break
    if (tag.closing) {
      const index = stack.map(s => s.name).lastIndexOf(tag.name)
      if (index >= 0) stack.length = index
      if (!stack.at(-1)?.hidden && blocks.has(tag.name)) emit('\n')
      continue
    }
    const classes = (tag.attrs.get('class') ?? '').split(/\s+/)
    const selectors = [...classes.map(c => `.${c}`), `#${tag.attrs.get('id') ?? ''}`], style = tag.attrs.get('style') ?? ''
    const hiddenBySelector = selectors.some(selector => hiddenSelectors.has(selector))
    if (conflictingVisibility(style) || (hiddenBySelector || stack.at(-1)?.hidden) && (visibilityProperty.test(style) || selectors.some(selector => otherVisibilitySelectors.has(selector)))) issues.add('Some conflicting HTML visibility could not be interpreted.')
    // Class names do not set visibility by themselves: a visible preheader may contain the only deadline.
    const hidden = !!stack.at(-1)?.hidden || suppressed.has(tag.name) || tag.attrs.has('hidden') || tag.attrs.get('aria-hidden')?.toLowerCase() === 'true' || hidesContent(style) || hiddenBySelector
    if (!hidden && blocks.has(tag.name)) emit('\n')
    if (!hidden && (tag.name === 'td' || tag.name === 'th')) emit(' ')
    if (!hidden && tag.name === 'img' && !['0', '1'].includes(tag.attrs.get('width') ?? '') && !['0', '1'].includes(tag.attrs.get('height') ?? '')) issues.add('Email images have not been read.')
    if (tag.name === 'link' && tag.attrs.get('rel')?.toLowerCase() === 'stylesheet') issues.add('External HTML styling has not been read.')
    if (tag.attrs.get('style')?.includes('\\')) issues.add('Some HTML styling could not be interpreted.')
    if (rawText.has(tag.name)) {
      const closing = new RegExp(`<\\/\\s*${tag.name}\\s*>`, 'gi')
      closing.lastIndex = offset
      const end = closing.exec(html)
      if (!end) { issues.add('An unfinished HTML section was not read.'); break }
      if (!hidden && tag.name === 'textarea') emit(decodeEntities(html.slice(offset, end.index), issues))
      offset = closing.lastIndex; continue
    }
    if (!voidTags.has(tag.name)) {
      if (stack.length >= 80) { issues.add('The HTML nesting exceeded the reading limit.'); truncated = true; break }
      stack.push({ name: tag.name, hidden })
    }
  }
  const cleaned = cleanText(chunks.join(''))
  cleaned.issues.forEach(i => issues.add(i))
  if (cleaned.text.length > gmailTextLimit) truncated = true
  if (truncated) issues.add('Email text was shortened to the reading limit.')
  return { text: clip(cleaned.text, gmailTextLimit), format: 'html', truncated, incomplete: truncated || issues.size > 0, issues: [...issues] }
}

export function extractGmailMessage(message: { payload?: GmailPart | null; snippet?: string | null }): GmailExtraction {
  const budget = { bytes: 0, parts: 0 }, globalIssues = new Set<string>()
  let attachments = false, bounded = false
  const walk = (part: GmailPart, depth: number, metadataOnly = false): Body => {
    if (++budget.parts > partLimit || depth > depthLimit) { bounded = true; globalIssues.add('The MIME structure exceeded the reading limit.'); return empty() }
    if (attached(part)) { attachments = true; return empty() }
    const type = mime(part)
    if (!type.startsWith('multipart/')) {
      if (type !== 'text/plain' && type !== 'text/html') {
        if (part.body?.attachmentId || part.body?.data || part.body?.size) { attachments = true }
        return empty()
      }
      if (metadataOnly) return empty()
      const decoded = decode(part, budget)
      if ('incomplete' in decoded) return decoded
      if (type === 'text/html') return htmlText(decoded.text)
      const cleaned = cleanText(decoded.text), truncated = cleaned.text.length > gmailTextLimit
      return { text: clip(cleaned.text, gmailTextLimit), format: 'plain', truncated, incomplete: truncated || cleaned.issues.length > 0, issues: [...cleaned.issues, ...(truncated ? ['Email text was shortened to the reading limit.'] : [])] }
    }
    let children = part.parts ?? []
    if (children.length > partLimit) { bounded = true; globalIssues.add('The MIME structure exceeded the reading limit.'); children = children.slice(0, partLimit) }
    if (type === 'multipart/alternative') {
      // Inspect MIME labels only when ordering alternatives. Decoding still has one shared byte/part budget.
      const hasPlain = (p: GmailPart, depth = 0, remaining = { count: partLimit }): boolean => {
        if (--remaining.count < 0 || depth > depthLimit || attached(p)) return false
        if (mime(p) === 'text/plain') return true
        return mime(p).startsWith('multipart/') && (p.parts ?? []).slice(0, partLimit).some(c => hasPlain(c, depth + 1, remaining))
      }
      children = children.map(child => ({ child, rank: mime(child) === 'text/plain' ? 0 : hasPlain(child) ? 1 : 2 })).sort((a, b) => a.rank - b.rank).map(p => p.child)
      let selected: Body | undefined
      const failed: Body[] = []
      for (const [index, child] of children.entries()) {
        const result = walk(child, depth + 1, metadataOnly || !!selected)
        if (result.text && !selected) selected = result
        else if (!selected) failed.push(result)
        if (budget.parts >= partLimit) {
          if (index < children.length - 1) { bounded = true; globalIssues.add('The MIME structure exceeded the reading limit.') }
          break
        }
      }
      return selected ?? { ...empty(), incomplete: failed.some(r => r.incomplete), truncated: failed.some(r => r.truncated), issues: failed.flatMap(r => r.issues) }
    }
    const results: Body[] = []
    for (const [index, child] of children.entries()) {
      results.push(walk(child, depth + 1, metadataOnly))
      if (budget.parts >= partLimit) {
        if (index < children.length - 1) { bounded = true; globalIssues.add('The MIME structure exceeded the reading limit.') }
        break
      }
    }
    const text = results.map(r => r.text).filter(Boolean).join('\n\n'), truncated = text.length > gmailTextLimit || results.some(r => r.truncated)
    return { text: clip(text, gmailTextLimit), format: results.some(r => r.format === 'html') ? 'html' : results.some(r => r.format === 'plain') ? 'plain' : 'unavailable', truncated, incomplete: truncated || results.some(r => r.incomplete), issues: unique([...results.flatMap(r => r.issues), ...(truncated ? ['Email text was shortened to the reading limit.'] : [])]) }
  }
  let body = message.payload ? walk(message.payload, 0) : empty()
  if (!body.text) {
    const snippet = cleanText(clip(message.snippet ?? '', gmailTextLimit + 1))
    body = { ...body, text: clip(snippet.text, gmailTextLimit), format: snippet.text ? 'snippet' : 'unavailable', incomplete: true, truncated: body.truncated || (message.snippet?.length ?? 0) > gmailTextLimit, issues: [...body.issues, ...snippet.issues, snippet.text ? 'Only the Gmail preview is available; the email body was not read.' : 'No readable email body is available.'] }
  }
  if (attachments) globalIssues.add('Attachments and inline files have not been read.')
  return { ...body, truncated: body.truncated || bounded, incomplete: body.incomplete || bounded || attachments, attachments, issues: unique([...body.issues, ...globalIssues]) }
}
