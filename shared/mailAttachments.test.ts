import { expect, it } from 'vitest'
import { attachmentDescriptors, attachmentPart, attachmentSupport, attachmentText, decodeAttachment, mailAttachmentLimits } from './mailAttachments.js'
const file = (extra = {}) => ({ partId: '0.1', filename: 'Permission form.txt', mimeType: 'text/plain', body: { attachmentId: 'attached_1', size: 12 }, ...extra })
it('discovers only named or disposition attachments without reading inline message bodies or URLs', () => {
  const payload = { mimeType: 'multipart/mixed', parts: [{ mimeType: 'text/plain', body: { data: 'aGVsbG8' } }, file(), { partId: '0.2', mimeType: 'image/png', headers: [{ name: 'Content-Disposition', value: 'attachment' }], body: { attachmentId: 'another', size: 1024 } }] }
  const result = attachmentDescriptors(payload)
  expect(result.descriptors).toHaveLength(2)
  expect(result.descriptors[0]).toMatchObject({ partId: '0.1', filename: 'Permission form.txt', supported: true, size: 12 })
  expect(attachmentPart(payload, '0.1')).toEqual(file())
  expect(attachmentPart(payload, 'https://attacker.example')).toBeNull()
})
it('bounds attachment count, MIME depth and parts while explicitly reporting incomplete discovery', () => {
  expect(attachmentDescriptors({ parts: Array.from({ length: 20 }, (_, i) => file({ partId: `${i}` })) })).toMatchObject({ incomplete: true, descriptors: expect.any(Array) })
  expect(attachmentDescriptors({ parts: Array.from({ length: 20 }, (_, i) => file({ partId: `${i}` })) }).descriptors).toHaveLength(12)
  let deep: any = file(); for (let i = 0; i < 20; i++) deep = { parts: [deep] }
  expect(attachmentDescriptors(deep)).toEqual({ descriptors: [], incomplete: true })
})
it('rejects duplicates, malformed identifiers and unsupported files without giving them download authority', () => {
  const result = attachmentDescriptors({ parts: [file(), file(), file({ partId: 'url:https://evil.test' }), file({ partId: '0.2', mimeType: 'application/zip' }), file({ partId: '0.3', body: { attachmentId: 'https://evil.test/a', size: 100 } })] })
  expect(result.incomplete).toBe(true)
  expect(result.descriptors).toHaveLength(3)
  expect(result.descriptors[1].supported).toBe(false)
  expect(result.descriptors[2]).toMatchObject({ supported: false })
  expect(result.descriptors[2].attachmentId).toBeUndefined()
})
it('normalizes untrusted filename controls and fingerprints account-independent metadata deterministically', () => {
  const result = attachmentDescriptors({ parts: [file({ filename: 'Form\u202e.exe\n.pdf' })] }).descriptors[0]
  expect(result.filename).toBe('Form .exe .pdf')
  expect(result.descriptorHash).toMatch(/^[a-f0-9]{64}$/)
  expect(attachmentDescriptors({ parts: [file({ filename: 'Form\u202e.exe\n.pdf' })] }).descriptors[0].descriptorHash).toBe(result.descriptorHash)
})
it.each(['text/html', 'image/svg+xml', 'application/octet-stream', 'application/msword', 'image/gif'])('marks %s unsupported', mime => expect(attachmentSupport(mime, 10)).not.toBeNull())
it('strictly enforces text/binary byte limits and canonical base64url without silently changing source bytes', () => {
  expect(attachmentSupport('text/plain', mailAttachmentLimits.textBytes + 1)).not.toBeNull()
  expect(attachmentSupport('application/pdf', mailAttachmentLimits.bytes + 1)).not.toBeNull()
  expect(new TextDecoder().decode(decodeAttachment('SGVsbG8', 5, 'text/plain'))).toBe('Hello')
  expect(() => decodeAttachment('SGVsbG8', 6, 'text/plain')).toThrow('byte count')
  for (const data of ['SGVsbG9', 'SGVsbG8===', 'SGVs bG8', 'SGVsbG8=', 'a']) {
    if (data === 'SGVsbG8=') expect(new TextDecoder().decode(decodeAttachment(data, 5, 'text/plain'))).toBe('Hello')
    else expect(() => decodeAttachment(data, 5, 'text/plain')).toThrow()
  }
})
it('retains literal UTF8 dates and numbers, refuses corrupt bytes and flags truncation/hidden controls', () => {
  expect(attachmentText(new TextEncoder().encode('Trip Oct 20 at 9:30.'))).toEqual({ text: 'Trip Oct 20 at 9:30.', incomplete: false, issues: [] })
  expect(() => attachmentText(Uint8Array.of(255))).toThrow()
  expect(attachmentText(new TextEncoder().encode('Return\u0000form'))).toMatchObject({ text: 'Return form', incomplete: true })
  expect(attachmentText(new TextEncoder().encode('a'.repeat(17000)))).toMatchObject({ text: 'a'.repeat(16000), incomplete: true })
})
