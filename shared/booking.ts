import { z } from 'zod'
import { Temporal } from '@js-temporal/polyfill'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

const label = z.string().trim().min(1).max(200)
export const bookingSchema = z.object({
  kind: z.literal('booking'), childId: z.string().trim().min(1).max(100).nullable(), site: z.literal('synthetic_activity'),
  venue: label, service: label, slotId: z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), timezone: label,
  participants: z.number().int().min(1).max(10), priceMinor: z.number().int().min(0).max(1_000_000), currency: z.literal('USD'),
  cancellationTerms: z.string().trim().min(1).max(2000), accountLabel: label, quoteVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), evidence: z.record(z.string().max(80), z.string().max(2000)).refine(value => Object.keys(value).length <= 20, 'Keep only relevant quote evidence.'),
}).strict().superRefine((value, context) => {
  try { Temporal.ZonedDateTime.from(`${value.date}T${value.startTime}:00[${value.timezone}]`, { disambiguation: 'reject', overflow: 'reject' }) }
  catch { context.addIssue({ code: 'custom', path: ['startTime'], message: 'Confirm a valid, unambiguous date, time and timezone.' }) }
})
export type BookingDraft = z.infer<typeof bookingSchema>

/** Stable over storage key order; every reviewed value, including quote lifetime, is bound. */
const canonical = (value: unknown): string => JSON.stringify(value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, JSON.parse(canonical(item))])) : value)
export function bookingHash(raw: BookingDraft): string { return bytesToHex(sha256(new TextEncoder().encode(canonical(bookingSchema.parse(raw))))) }
export function bookingChanges(before: BookingDraft, after: BookingDraft): (keyof BookingDraft)[] {
  const original = bookingSchema.parse(before), current = bookingSchema.parse(after)
  return (Object.keys(original) as (keyof BookingDraft)[]).filter(key => canonical(original[key]) !== canonical(current[key]))
}

export const bookingApprovalSchema = z.object({ draftHash: z.string().regex(/^[a-f0-9]{64}$/), operationKey: z.string().regex(/^[a-zA-Z0-9_-]{16,100}$/), approvedAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), connectionId: z.string().min(1).max(100), connectionVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict()
export type BookingApproval = z.infer<typeof bookingApprovalSchema>
export function checkBookingApproval(draft: BookingDraft, approval: BookingApproval | null, now: number, spendLimitMinor: number, connection: { id: string; version: number }) {
  const value = bookingSchema.parse(draft)
  if (!approval) throw new Error('Review and approve this booking before submitting it.')
  const approved = bookingApprovalSchema.parse(approval)
  if (approved.connectionId !== connection.id || approved.connectionVersion !== connection.version) throw new Error('The booking account connection changed. Review with the current account.')
  if (approved.draftHash !== bookingHash(value)) throw new Error('The booking changed after approval. Review its current details.')
  if (approved.approvedAt > now || approved.approvedAt >= value.expiresAt || now >= value.expiresAt) throw new Error('This quote or approval expired. Review a fresh quote.')
  if (!Number.isSafeInteger(spendLimitMinor) || spendLimitMinor < 0 || value.priceMinor > spendLimitMinor) throw new Error('This booking exceeds the allowed total price.')
  return approved
}

export const bookingReservationSchema = z.object({ reservationId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), status: z.literal('confirmed'), operationKey: z.string().regex(/^[a-zA-Z0-9_-]{16,100}$/), accountLabel: label, draftHash: z.string().regex(/^[a-f0-9]{64}$/), booking: bookingSchema }).strict()
export type BookingReservation = z.infer<typeof bookingReservationSchema>
/** Read-back can verify an expired historical quote; expiration only blocks new dispatch. */
export function bookingReadback(expected: BookingDraft, raw: unknown, operationKey: string): { verified: boolean; differences: string[]; reservation?: BookingReservation } {
  const parsed = bookingReservationSchema.safeParse(raw)
  if (!parsed.success) return { verified: false, differences: ['reservation'] }
  const result = parsed.data, differences: string[] = bookingChanges(expected, result.booking)
  if (result.operationKey !== operationKey) differences.push('operationKey')
  if (result.accountLabel !== expected.accountLabel) differences.push('accountLabel')
  if (result.draftHash !== bookingHash(expected) || result.draftHash !== bookingHash(result.booking)) differences.push('draftHash')
  return { verified: !differences.length, differences: [...new Set(differences)], ...(!differences.length ? { reservation: result } : {}) }
}
