import { hash, type PickupDraft } from './daymark.js'

export type PickupEmailProof = { accountEmail: string; childName: string; webUrl: string; to: string; subject: string; body: string; reminder?: { at: string; subject: string; body: string }; hash: string }
export type PickupEmailReview = { channel: 'app' | 'email'; transport?: 'gmail' | 'resend'; from?: string; to: string; subject?: string; body?: string; reminder?: { at: string; subject: string; body: string }; hash?: string }
export function pickupEmailMessage(payload: PickupDraft, childName: string, webUrl: string, secret?: string, reminder = false) {
  const link = `${webUrl}/#pickup=${secret ?? '[private link]'}`
  return { subject: reminder ? 'One reminder: pickup request' : 'A pickup request', body: `${payload.message}\n\nChild: ${childName}\nPickup: ${payload.date} ${payload.time} (${payload.timezone})\nLocation: ${payload.location}\nReply before: ${payload.deadline}\n\nSign in with the caregiver email to respond privately:\n${link}\n\n${reminder ? 'This is the one reminder approved by the parent. ' : ''}A request is not a confirmed arrangement.` }
}
export function pickupEmailProof(payload: PickupDraft, childName: string, webUrl: string, accountEmail: string, to: string): PickupEmailProof {
  const url = new URL(webUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('A secure response page is required.')
  const root = url.origin, invitation = pickupEmailMessage(payload, childName, root)
  const value = { accountEmail: accountEmail.toLowerCase(), childName, webUrl: root, to: to.toLowerCase(), ...invitation, ...(payload.followUpAt ? { reminder: { at: payload.followUpAt, ...pickupEmailMessage(payload, childName, root, undefined, true) } } : {}) }
  return { ...value, hash: hash(JSON.stringify(value)) }
}
