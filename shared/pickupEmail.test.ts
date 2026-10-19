import { expect, it } from 'vitest'
import type { PickupDraft } from './daymark.js'
import { pickupEmailMessage, pickupEmailProof } from './pickupEmail.js'

const payload: PickupDraft = {
  kind: 'pickup', childId: 'synthetic-child', caregiverId: 'synthetic-caregiver', date: '2027-05-05', time: '15:00', timezone: 'America/Los_Angeles',
  location: 'School north gate', deadline: '2027-05-05T19:00:00Z', message: 'Could you collect Maya after school?', evidence: {},
}
const origin = 'https://response.example.test'
const proof = (p = payload, childName = 'Maya', webUrl = origin, accountEmail = 'parent@example.test', to = 'caregiver@example.test') => pickupEmailProof(p, childName, webUrl, accountEmail, to)

it('shows the exact request, response identity and confirmation limitation in the reviewed invitation', () => {
  expect(pickupEmailMessage(payload, 'Maya', origin)).toEqual({
    subject: 'A pickup request',
    body: 'Could you collect Maya after school?\n\nChild: Maya\nPickup: 2027-05-05 15:00 (America/Los_Angeles)\nLocation: School north gate\nReply before: 2027-05-05T19:00:00Z\n\nSign in with the caregiver email to respond privately:\nhttps://response.example.test/#pickup=[private link]\n\nA request is not a confirmed arrangement.',
  })
  expect(proof()).toMatchObject({ accountEmail: 'parent@example.test', childName: 'Maya', webUrl: origin, to: 'caregiver@example.test', ...pickupEmailMessage(payload, 'Maya', origin) })
})

it.each(['sender', 'recipient', 'child', 'origin', 'message', 'date', 'time', 'timezone', 'location', 'deadline', 'reminder added', 'reminder time'] as const)('invalidates the reviewed proof when %s changes', change => {
  const baseline = { ...payload, followUpAt: '2027-05-05T18:00:00Z' }
  let modified = { ...baseline }, child = 'Maya', webUrl = origin, from = 'parent@example.test', to = 'caregiver@example.test'
  if (change === 'sender') from = 'other-parent@example.test'
  if (change === 'recipient') to = 'other-caregiver@example.test'
  if (change === 'child') child = 'Sam'
  if (change === 'origin') webUrl = 'https://other-response.example.test'
  if (change === 'message') modified.message = 'Please collect Maya from the office.'
  if (change === 'date') modified.date = '2027-05-06'
  if (change === 'time') modified.time = '15:30'
  if (change === 'timezone') modified.timezone = 'America/New_York'
  if (change === 'location') modified.location = 'School office'
  if (change === 'deadline') modified.deadline = '2027-05-05T19:30:00Z'
  if (change === 'reminder time') modified.followUpAt = '2027-05-05T18:30:00Z'
  const original = change === 'reminder added' ? proof(payload) : proof(baseline)
  const changed = proof(modified, child, webUrl, from, to)
  expect(changed.hash).toMatch(/^[a-f0-9]{64}$/)
  expect(changed.hash).not.toBe(original.hash)
})

it('normalizes only equivalent sender, recipient and response-origin spelling for a stable proof', () => {
  expect(proof(payload, 'Maya', 'https://RESPONSE.EXAMPLE.TEST:443/', 'PARENT@EXAMPLE.TEST', 'CAREGIVER@EXAMPLE.TEST')).toEqual(proof())
  expect(proof()).toEqual(proof({ ...payload }))
})

it.each([false, true])('renders the reviewed %s reminder template by replacing only its generated private link', reminder => {
  const p = { ...payload, followUpAt: '2027-05-05T18:00:00Z' }, reviewed = proof(p)
  const expected = reminder ? reviewed.reminder! : reviewed
  const secret = 'synthetic_base64url_secret-123', delivered = pickupEmailMessage(p, 'Maya', reviewed.webUrl, secret, reminder)
  expect(delivered.subject).toBe(expected.subject)
  expect(delivered.body).toBe(expected.body.replace('[private link]', secret))
  expect(delivered.body.match(/#pickup=/g)).toHaveLength(1)
  expect(delivered.body).not.toContain('[private link]')
  const linkLine = delivered.body.split('\n').find(line => line.startsWith('https://'))!
  const link = new URL(linkLine)
  expect(link.origin).toBe(origin)
  expect(link.pathname).toBe('/')
  expect(link.search).toBe('')
  expect(link.hash).toBe(`#pickup=${secret}`)
})

it('includes exactly the explicitly approved reminder time and reminder wording', () => {
  const p = { ...payload, followUpAt: '2027-05-05T18:00:00Z' }, reviewed = proof(p)
  expect(reviewed.reminder).toEqual({ at: p.followUpAt, ...pickupEmailMessage(p, 'Maya', origin, undefined, true) })
  expect(reviewed.reminder!.subject).toBe('One reminder: pickup request')
  expect(reviewed.reminder!.body).toContain('This is the one reminder approved by the parent. A request is not a confirmed arrangement.')
  expect(reviewed.body).not.toContain('one reminder approved')
})

it('does not infer a reminder from a response deadline or include a reminder without followUpAt', () => {
  const reviewed = proof()
  expect(reviewed).not.toHaveProperty('reminder')
  expect(reviewed.body).not.toContain('one reminder approved')
  expect(proof({ ...payload, deadline: '2027-05-05T20:00:00Z' })).not.toHaveProperty('reminder')
})

it.each([
  'http://response.example.test',
  'javascript:alert(1)',
  '//response.example.test',
  'not a URL',
  'https://response.example.test?return=https://other.example.test',
  'https://response.example.test/#pickup=existing-secret',
  'https://response.example.test/#other-route',
  'https://parent@response.example.test',
  'https://parent:password@response.example.test',
  'https://:password@response.example.test',
  'https://response.example.test/pickup',
  'https://response.example.test/pickup/',
  'https://response.example.test//',
])('rejects unsafe or non-root response-page configuration %s', webUrl => {
  expect(() => proof(payload, 'Maya', webUrl)).toThrow()
})
