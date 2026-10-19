import { expect, it } from 'vitest'
import { hash } from './daymark.js'
import { decodeGmailSubject, gmailReplyHash, gmailReplyRouting, gmailReplyRoutingSchema } from './gmailReply.js'

const source = () => ({ threadId: 'thread-123', payload: { headers: [{ name: 'Message-ID', value: '<parent.1@school.example>' }, { name: 'Subject', value: 'Picnic 🌞' }, { name: 'References', value: '<first@school.example>\r\n <second@school.example>' }] } })
const expected = { threadId: 'thread-123', inReplyTo: '<parent.1@school.example>', references: ['<first@school.example>', '<second@school.example>', '<parent.1@school.example>'], subject: 'Re: Picnic 🌞' }
it('derives a bounded reply chain from the source headers, retaining the exact provider thread', () => {
  expect(gmailReplyRouting(source())).toEqual(expected)
  const message = source(); message.payload.headers = message.payload.headers.filter(h => h.name !== 'References')
  expect(gmailReplyRouting(message)).toEqual({ ...expected, references: [expected.inReplyTo] })
  message.payload.headers.push({ name: 'In-Reply-To', value: '<earlier-parent@school.example>' })
  expect(gmailReplyRouting(message)?.references).toEqual(['<earlier-parent@school.example>', expected.inReplyTo])
})
it('decodes UTF-8 encoded source subjects before choosing the matching reply subject', () => {
  const message = source()
  message.payload.headers[1].value = '=?UTF-8?B?UGljbmljIA==?=\r\n =?UTF-8?B?8J+Mng==?='
  expect(gmailReplyRouting(message)?.subject).toBe('Re: Picnic 🌞')
  expect(decodeGmailSubject('Re: =?UTF-8?Q?Picnic_=F0=9F=8C=9E?=')).toBe('Re: Picnic 🌞')
  expect(decodeGmailSubject('=?UTF-8?Q?Hi=0ABcc:_hidden@example.test?=')).toBeUndefined()
  expect(decodeGmailSubject('=?UTF-8?B?/w==?=')).toBeUndefined()
  expect(decodeGmailSubject('=?unknown?B?SGk=?=')).toBeUndefined()
})
it.each(['missing message ID', 'duplicate message ID', 'injected message ID', 'malformed references', 'duplicate references', 'injected subject', 'invalid thread', 'oversized subject', 'oversized chain'] as const)('does not invent routing for %s', change => {
  const message = source()
  if (change === 'missing message ID') message.payload.headers.shift()
  if (change === 'duplicate message ID') message.payload.headers.push({ name: 'Message-ID', value: '<other@school.example>' })
  if (change === 'injected message ID') message.payload.headers[0].value += '\r\nBcc: hidden@example.test'
  if (change === 'malformed references') message.payload.headers[2].value += ' other text'
  if (change === 'duplicate references') message.payload.headers.push({ name: 'References', value: '<other@school.example>' })
  if (change === 'injected subject') message.payload.headers[1].value += '\nBcc: hidden@example.test'
  if (change === 'invalid thread') message.threadId = 'thread\nother'
  if (change === 'oversized subject') message.payload.headers[1].value = 'S'.repeat(297)
  if (change === 'oversized chain') message.payload.headers[2].value = Array.from({ length: 50 }, (_, i) => `<message-${i}@school.example>`).join(' ')
  expect(gmailReplyRouting(message)).toBeUndefined()
})
it('binds routing into the approval while preserving legacy standalone digests', () => {
  const input = { to: 'school@example.test', subject: expected.subject, body: 'Thanks!' }
  expect(gmailReplyHash(input)).toBe(hash(JSON.stringify(input)))
  const approved = gmailReplyHash(input, expected)
  expect(approved).not.toBe(gmailReplyHash(input))
  expect(gmailReplyHash(input, { ...expected, threadId: 'another-thread' })).not.toBe(approved)
  expect(() => gmailReplyHash({ ...input, subject: 'Different conversation' }, expected)).toThrow('original reply subject')
  expect(gmailReplyRoutingSchema.safeParse({ ...expected, references: ['<other@school.example>'] }).success).toBe(false)
})
