// @vitest-environment node
import { expect, it } from 'vitest'
import { Webhook } from 'svix'
import { senderAuthenticated, trustedDownload, verifiedWebhook } from './forwarding'
it('verifies raw webhook signatures, rejects tampering and stale delivery', () => {
  const secret = `whsec_${Buffer.alloc(32, 1).toString('base64')}`, raw = JSON.stringify({ type: 'email.received', data: { email_id: 'synthetic', to: ['test@example.test'] } }), at = new Date(), id = 'synthetic-message'
  const signature = new Webhook(secret).sign(id, at, raw)
  expect(verifiedWebhook(raw, id, String(Math.floor(at.getTime() / 1000)), signature, secret).type).toBe('email.received')
  expect(() => verifiedWebhook(raw + ' ', id, String(Math.floor(at.getTime() / 1000)), signature, secret)).toThrow()
  expect(() => verifiedWebhook(raw, id, '1', signature, secret)).toThrow()
})
it('uses receiver-authenticated DMARC rather than forgeable headers, and restricts attachment URLs', () => {
  const mail = { from: 'Parent <parent@example.test>', authentication: { dmarc: 'pass', dkim: 'pass' } }
  expect(senderAuthenticated(mail, 'parent@example.test')).toBe(true)
  expect(senderAuthenticated({ ...mail, authentication: null, headers: { 'authentication-results': 'dmarc=pass' } }, 'parent@example.test')).toBe(false)
  expect(senderAuthenticated(mail, 'other@example.test')).toBe(false)
  expect(() => trustedDownload('http://127.0.0.1/private')).toThrow()
  expect(() => trustedDownload('https://inbound-cdn.resend.com.evil.test/')).toThrow()
  expect(trustedDownload('https://inbound-cdn.resend.com/synthetic')).toContain('/synthetic')
})
