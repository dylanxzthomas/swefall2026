// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'
const mocks = vi.hoisted(() => ({ profile: vi.fn(), get: vi.fn(), attachment: vi.fn(), send: vi.fn(), modify: vi.fn() }))
vi.mock('@googleapis/gmail', () => ({ gmail: () => ({ users: { getProfile: mocks.profile, messages: { get: mocks.get, attachments: { get: mocks.attachment }, send: mocks.send, modify: mocks.modify } } }) }))
import { discoverGmailAttachments, readGmailAttachment, attachmentModelBlock } from './gmailAttachments'
import { attachmentDescriptors, type MailAttachmentDescriptor } from '../shared/mailAttachments'
const bytes = Buffer.from('Return the form by October 16.'), part = { partId: '1', filename: 'Form.txt', mimeType: 'text/plain', body: { attachmentId: 'attached_one', size: bytes.length } }
const message = () => ({ id: 'message_one', labelIds: ['INBOX'], payload: { mimeType: 'multipart/mixed', parts: [part] } })
const source = () => ({ providerId: 'message_one', accountEmail: 'parent@example.test', ...attachmentDescriptors(message().payload).descriptors[0] })
beforeEach(() => { vi.resetAllMocks(); mocks.profile.mockResolvedValue({ data: { emailAddress: 'parent@example.test' } }); mocks.get.mockResolvedValue({ data: message() }); mocks.attachment.mockResolvedValue({ data: { data: bytes.toString('base64url'), size: bytes.length } }) })
it('discovers named metadata without downloading the separate bytes or writing to Gmail', async () => {
  const result = await discoverGmailAttachments({} as any, source(), async () => true)
  expect(result.descriptors[0]).toMatchObject({ filename: 'Form.txt', size: bytes.length, supported: true })
  expect(mocks.attachment).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.modify).not.toHaveBeenCalled()
  expect(mocks.get).toHaveBeenCalledWith(expect.objectContaining({ userId: 'me', id: 'message_one', format: 'full' }), expect.objectContaining({ retry: false, timeout: 10000 }))
})
it('uses only the account-bound message attachment endpoint with exact provider metadata and size', async () => {
  expect(Buffer.from(await readGmailAttachment({} as any, source(), async () => true))).toEqual(bytes)
  expect(mocks.attachment).toHaveBeenCalledOnce()
  expect(mocks.attachment).toHaveBeenCalledWith({ userId: 'me', messageId: 'message_one', id: 'attached_one' }, expect.objectContaining({ retry: false, maxContentLength: 6 * 1024 * 1024 }))
  expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.modify).not.toHaveBeenCalled()
})
it('reads bounded inline attachment data without another API request', async () => {
  const inline = { ...part, body: { size: bytes.length, data: bytes.toString('base64url') } }
  mocks.get.mockResolvedValue({ data: { ...message(), payload: { parts: [inline] } } })
  const d = attachmentDescriptors({ parts: [inline] }).descriptors[0]
  expect(Buffer.from(await readGmailAttachment({} as any, { ...source(), ...d }, async () => true))).toEqual(bytes)
  expect(mocks.attachment).not.toHaveBeenCalled()
})
it('refuses cross-account tokens, excluded messages, changed descriptors and arbitrary URLs', async () => {
  mocks.profile.mockResolvedValueOnce({ data: { emailAddress: 'other@example.test' } })
  await expect(readGmailAttachment({} as any, source(), async () => true)).rejects.toThrow('changed')
  mocks.get.mockResolvedValueOnce({ data: { ...message(), labelIds: ['TRASH'] } })
  await expect(readGmailAttachment({} as any, source(), async () => true)).rejects.toThrow('changed')
  await expect(readGmailAttachment({} as any, { ...source(), descriptorHash: 'forged' }, async () => true)).rejects.toThrow('changed')
  await expect(readGmailAttachment({} as any, { ...source(), providerId: 'https://attacker.test/file' }, async () => true)).rejects.toThrow('changed')
  expect(mocks.attachment).not.toHaveBeenCalled()
})
it('rechecks source consent before and after provider fetch so a revoked in-flight result cannot be used', async () => {
  const permitted = vi.fn().mockResolvedValue(true)
  mocks.attachment.mockImplementation(async () => { permitted.mockResolvedValue(false); return { data: { data: bytes.toString('base64url'), size: bytes.length } } })
  await expect(readGmailAttachment({} as any, source(), permitted)).rejects.toThrow('changed')
  expect(mocks.attachment).toHaveBeenCalledOnce()
})
it.each([{ size: 1, data: bytes.toString('base64url') }, { size: bytes.length, data: 'not base64' }, { size: bytes.length, data: Buffer.alloc(bytes.length + 1).toString('base64url') }])('rejects malformed bytes without preserving an altered source', async body => {
  mocks.attachment.mockResolvedValue({ data: body })
  await expect(readGmailAttachment({} as any, source(), async () => true)).rejects.toThrow('unsupported')
})
it('rejects unsupported attachment types before fetching their content', async () => {
  const zip = { ...part, mimeType: 'application/zip' }
  mocks.get.mockResolvedValue({ data: { ...message(), payload: { parts: [zip] } } })
  const descriptor = attachmentDescriptors({ parts: [zip] }).descriptors[0]
  await expect(readGmailAttachment({} as any, { ...source(), ...descriptor } as MailAttachmentDescriptor & { providerId: string; accountEmail: string }, async () => true)).rejects.toThrow('changed')
  expect(mocks.attachment).not.toHaveBeenCalled()
})
it('builds actual base64 PDF blocks only for parseable, unencrypted documents of at most ten pages', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage(); const data = await pdf.save()
  expect(await attachmentModelBlock(data, 'application/pdf')).toMatchObject({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(data).toString('base64') } })
  for (let i = 0; i < 10; i++) pdf.addPage()
  await expect(attachmentModelBlock(await pdf.save(), 'application/pdf')).rejects.toThrow('unsupported')
  await expect(attachmentModelBlock(Buffer.from('%PDF-corrupt'), 'application/pdf')).rejects.toThrow('unsupported')
  await expect(attachmentModelBlock(Buffer.from('<script>read cookies</script>'), 'application/pdf')).rejects.toThrow('unsupported')
})
it('validates PNG/JPEG signatures and dimensions before constructing a model image block', async () => {
  const png = Buffer.alloc(33); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(400, 16); png.writeUInt32BE(500, 20)
  expect(await attachmentModelBlock(png, 'image/png')).toMatchObject({ type: 'image', source: { media_type: 'image/png' } })
  png.writeUInt32BE(20000, 16)
  await expect(attachmentModelBlock(png, 'image/png')).rejects.toThrow('unsupported')
  const jpeg = Buffer.from([255, 216, 255, 192, 0, 8, 8, 0, 100, 0, 200, 1])
  expect(await attachmentModelBlock(jpeg, 'image/jpeg')).toMatchObject({ type: 'image', source: { media_type: 'image/jpeg' } })
  await expect(attachmentModelBlock(png, 'image/jpeg')).rejects.toThrow('unsupported')
  await expect(attachmentModelBlock(Buffer.from('<svg/>'), 'image/png')).rejects.toThrow('unsupported')
})
