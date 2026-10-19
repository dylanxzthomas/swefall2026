import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { MailAttachments } from './MailAttachments'
import type { PrivateMailAttachment } from '../../../shared/mailAttachments'
const row: PrivateMailAttachment = { id: 'attachment-one', version: 1, descriptorHash: 'fingerprint', messageId: 'mail-one', filename: 'Permission.pdf', mimeType: 'application/pdf', size: 12000, status: 'available', expiresAt: Date.now() + 86400_000, updatedAt: Date.now(), retryable: false }
const render = (rows = [row]) => renderToStaticMarkup(<MailAttachments messageId="mail-one" messageVersion={1} attachments={rows} discover={async () => ({ incomplete: false, count: 1 })} read={async () => 2} />)
it('requires a file choice and explains private model processing before reading', () => {
  const html = render()
  expect(html).toContain('Read privately')
  expect(html).toContain('sent to the configured AI provider')
  expect(html).toContain('original file is not saved')
  expect(html).toContain('Nothing is shared or sent')
})
it('keeps unsupported files visible without a misleading read or completion button', () => {
  const html = render([{ ...row, status: 'unsupported', issue: 'Encrypted PDF cannot be read.' }])
  expect(html).toContain('Encrypted PDF cannot be read.')
  expect(html).not.toContain('Read privately')
  expect(html).not.toContain('AI transcription')
})
it('distinguishes machine transcription and partial reading from original source text', () => {
  const html = render([{ ...row, status: 'complete', text: 'Return by October 16.', extractionMethod: 'model', incomplete: true, issues: ['Page 2 was illegible.'] }])
  expect(html).toContain('AI transcription')
  expect(html).toContain('check dates, names and numbers against the original')
  expect(html).toContain('Page 2 was illegible.')
  expect(html).toContain('Read extracted text')
  expect(html).not.toContain('Read privately')
})
it('excludes expired and other-message attachments from the private source view', () => {
  const html = render([{ ...row, expiresAt: Date.now() - 1 }, { ...row, id: 'other', messageId: 'mail-two', filename: 'Private-other.pdf' }])
  expect(html).not.toContain('Permission.pdf')
  expect(html).not.toContain('Private-other.pdf')
  expect(html).toContain('Show attachments')
})
