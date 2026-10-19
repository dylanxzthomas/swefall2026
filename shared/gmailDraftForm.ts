/** Exact recognized text serialization only; no HTML stripping or whitespace collapse. */
export function simplePlainHtmlMatches(html: string, expected: string): boolean {
  const actual = html.replace(/[\r\n]+$/, ''), text = expected.replace(/\r\n|\r/g, '\n').replace(/[\r\n]+$/, '')
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const escapedQuotes = escaped.replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  const wrappers = ['', '<div>', '<div dir="ltr">', '<div dir="auto">']
  for (const value of [escaped, escapedQuotes]) for (const br of ['<br>', '<br/>', '<br />']) {
    const body = value.split('\n').join(br)
    for (const wrapper of wrappers) for (const terminal of ['', br]) {
      if (actual === `${wrapper}${body}${terminal}${wrapper ? '</div>' : ''}`) return true
    }
  }
  return false
}

/** Gmail's normal form can add one final line break, never spaces or blank paragraphs. */
export function plainDraftBodyMatches(actual: string, expected: string): boolean {
  const body = actual.replace(/\r\n/g, '\n'), approved = expected.replace(/\r\n/g, '\n')
  return !body.includes('\r') && !approved.includes('\r') && (body === approved || body === `${approved}\n`)
}
