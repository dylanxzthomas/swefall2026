export async function deliver(to: string, subject: string, text: string, key: string): Promise<string> {
  if (process.env.DAYMARK_ENVIRONMENT !== 'production' && !(process.env.DAYMARK_TEST_EMAIL_RECIPIENTS ?? '').split(',').map(e => e.trim().toLowerCase()).includes(to.toLowerCase())) throw new Error('Recipient is not an allowlisted dedicated test account.')
  if (!process.env.RESEND_API_KEY || !process.env.DAYMARK_EMAIL_FROM) throw new Error('Transactional email is disconnected.')
  const result = await fetch('https://api.resend.com/emails', { method: 'POST', signal: AbortSignal.timeout(25_000), headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ from: process.env.DAYMARK_EMAIL_FROM, to: [to], subject, text }) })
  if (!result.ok) throw new Error('Transactional provider did not confirm acceptance.')
  const value = await result.json() as { id?: string }
  if (!value.id) throw new Error('Missing provider message ID.')
  return value.id
}
