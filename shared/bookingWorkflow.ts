import { bookingApprovalSchema, bookingChanges, bookingHash, bookingReadback, bookingSchema, checkBookingApproval, type BookingApproval, type BookingDraft, type BookingReservation } from './booking.js'

export type BookingConnection = { id: string; version: number; site: BookingDraft['site']; accountLabel: string; state: 'ready' | 'missing' | 'revoked' | 'takeover_required' }
export type BookingAccess = { cancelled: boolean; connection: BookingConnection | null }
export type BookingCheckpoint = { operationKey: string; draftHash: string; connectionId: string; connectionVersion: number; state: 'dispatched' | 'uncertain' | 'verified'; reservation?: BookingReservation }
export interface BookingCheckpointStore {
  read(operationKey: string): Promise<BookingCheckpoint | null>
  /** Must atomically create a previously absent operation; never overwrite an existing operation. */
  claim(checkpoint: BookingCheckpoint): Promise<boolean>
  /** Must check the operation/hash before recording a result. Preserve already verified receipts. */
  settle(operationKey: string, draftHash: string, result: { state: 'uncertain' } | { state: 'verified'; reservation: BookingReservation }): Promise<void>
}
export type TakeoverReason = 'login' | 'mfa' | 'captcha' | 'payment' | 'unsupported_page'
export class BookingTakeoverRequired extends Error {
  constructor(public readonly reason: TakeoverReason) { super('This site needs the parent to take over.') }
}
export interface BookingSiteAdapter {
  /** An installed site adapter, never an arbitrary URL or model-supplied script. */
  readonly site: BookingDraft['site']
  inspect(request: { slotId: string; participants: number; childId: string | null }, signal: AbortSignal): Promise<BookingDraft>
  submit(request: { booking: BookingDraft; operationKey: string }, signal: AbortSignal): Promise<void>
  readReservation(operationKey: string, signal: AbortSignal): Promise<unknown | null>
}
export type BookingOutcome =
  | { state: 'connection_needed'; message: string }
  | { state: 'takeover'; reason: TakeoverReason; message: string }
  | { state: 'needs_review'; message: string; quote?: BookingDraft; changes?: string[] }
  | { state: 'cancelled'; message: string }
  | { state: 'uncertain'; message: string }
  | { state: 'verified'; reservation: BookingReservation }
export type BookingWorkflowContext = {
  adapter: BookingSiteAdapter; checkpoints: BookingCheckpointStore;
  /** Backend-owned authentication, membership, cancellation and connection state. Not model input. */
  readAccess(): Promise<BookingAccess>;
  spendLimitMinor: number; now?: () => number; timeoutMs?: number;
}

function gate(access: BookingAccess, draft: BookingDraft): BookingOutcome | null {
  if (access.cancelled) return { state: 'cancelled', message: 'This booking request was stopped. No new submission is allowed.' }
  if (!access.connection || ['missing', 'revoked'].includes(access.connection.state)) return { state: 'connection_needed', message: 'Connect the intended booking account before continuing.' }
  if (access.connection.state === 'takeover_required') return { state: 'takeover', reason: 'login', message: 'Complete the account sign-in in the protected site session.' }
  if (access.connection.site !== draft.site || access.connection.accountLabel !== draft.accountLabel) return { state: 'needs_review', message: 'The site or account changed. Review a quote for the current account.', changes: ['accountLabel'] }
  return null
}
function budget(timeoutMs = 20_000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error('Booking work needs a time budget of at most two minutes.')
  const controller = new AbortController(), until = Date.now() + timeoutMs
  let operations = 0
  return { async call<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (++operations > 8 || controller.signal.aborted || Date.now() >= until) throw new Error('Booking work reached its limit.')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([fn(controller.signal), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Booking work timed out.')) }, Math.max(1, until - Date.now())) })])
    } finally { if (timer) clearTimeout(timer) }
  }, remaining() { return Math.max(1, until - Date.now()) }, close() { controller.abort() } }
}

function uncertain(): BookingOutcome { return { state: 'uncertain', message: 'The reservation is not verified. Check the existing operation before trying another submission.' } }
async function record(context: BookingWorkflowContext, operationKey: string, draftHash: string, result: { state: 'uncertain' } | { state: 'verified'; reservation: BookingReservation }): Promise<boolean> {
  try { await context.checkpoints.settle(operationKey, draftHash, result); return true } catch { return false }
}

/** Reconciliation is read-only, including when no reservation is visible yet. */
export async function reconcileBooking(context: BookingWorkflowContext, raw: BookingDraft, operationKey: string): Promise<BookingOutcome> {
  const draft = bookingSchema.parse(raw), access = await context.readAccess(), saved = await context.checkpoints.read(operationKey)
  if (!saved || saved.draftHash !== bookingHash(draft)) return { state: 'needs_review', message: 'No matching dispatched operation is recorded.' }
  // An already verified receipt remains true after revocation or cancellation; it causes no new call.
  if (saved.state === 'verified' && saved.reservation) {
    const check = bookingReadback(draft, saved.reservation, operationKey)
    if (check.verified) return { state: 'verified', reservation: check.reservation! }
  }
  const blocked = gate({ ...access, cancelled: false }, draft)
  if (blocked) return blocked
  if (access.connection!.id !== saved.connectionId || access.connection!.version !== saved.connectionVersion) return { state: 'connection_needed', message: 'Reconnect the original booking account before checking its result.' }
  if (context.adapter.site !== draft.site) return { state: 'needs_review', message: 'This booking site has no matching adapter.' }
  const work = budget(context.timeoutMs)
  try {
    const result = await work.call(signal => context.adapter.readReservation(operationKey, signal)), check = bookingReadback(draft, result, operationKey)
    if (!check.verified) { await record(context, operationKey, saved.draftHash, { state: 'uncertain' }); return uncertain() }
    if (!await record(context, operationKey, saved.draftHash, { state: 'verified', reservation: check.reservation! })) return uncertain()
    return { state: 'verified', reservation: check.reservation! }
  } catch (cause) {
    await record(context, operationKey, saved.draftHash, { state: 'uncertain' })
    if (cause instanceof BookingTakeoverRequired) return { state: 'takeover', reason: cause.reason, message: 'The site needs your help before its existing reservation can be checked. Nothing will be resubmitted.' }
    return uncertain()
  } finally { work.close() }
}

/** The caller supplies a real recorded approval; model output cannot supply the checkpoint store. */
export async function executeBooking(context: BookingWorkflowContext, raw: BookingDraft, approval: BookingApproval | null): Promise<BookingOutcome> {
  const draft = bookingSchema.parse(raw)
  if (!approval) return { state: 'needs_review', message: 'Review and approve the exact booking details before submitting.' }
  const parsedApproval = bookingApprovalSchema.parse(approval)
  const access = await context.readAccess()
  const previous = await context.checkpoints.read(parsedApproval.operationKey)
  if (previous) {
    if (parsedApproval.draftHash !== bookingHash(draft) || previous.draftHash !== bookingHash(draft) || previous.connectionId !== parsedApproval.connectionId || previous.connectionVersion !== parsedApproval.connectionVersion) return { state: 'needs_review', message: 'This operation belongs to a different booking approval.' }
    return reconcileBooking(context, draft, parsedApproval.operationKey)
  }
  const blocked = gate(access, draft)
  if (blocked) return blocked
  if (context.adapter.site !== draft.site) return { state: 'needs_review', message: 'This booking site has no matching adapter.' }
  const now = context.now ?? Date.now
  try { checkBookingApproval(draft, parsedApproval, now(), context.spendLimitMinor, access.connection!) }
  catch (cause) { return { state: 'needs_review', message: (cause as Error).message } }
  const work = budget(context.timeoutMs), hash = bookingHash(draft)
  let dispatched = false, claiming = false
  try {
    const fresh = bookingSchema.parse(await work.call(signal => context.adapter.inspect({ slotId: draft.slotId, participants: draft.participants, childId: draft.childId }, signal)))
    const changes = bookingChanges(draft, fresh)
    if (changes.length) return { state: 'needs_review', message: 'The site’s quote changed. Review it before booking.', quote: fresh, changes }
    const latest = await context.readAccess(), stopped = gate(latest, draft)
    if (stopped) return stopped
    try { checkBookingApproval(fresh, parsedApproval, now(), context.spendLimitMinor, latest.connection!) }
    catch (cause) { return { state: 'needs_review', message: (cause as Error).message } }
    claiming = true
    const claimed = await context.checkpoints.claim({ operationKey: parsedApproval.operationKey, draftHash: hash, connectionId: parsedApproval.connectionId, connectionVersion: parsedApproval.connectionVersion, state: 'dispatched' })
    if (!claimed) return reconcileBooking({ ...context, timeoutMs: work.remaining() }, draft, parsedApproval.operationKey)
    dispatched = true
    // This checkpoint precedes the click. Interruption from here on always reconciles first.
    const finalAccess = await context.readAccess(), finalBlock = gate(finalAccess, draft)
    if (finalBlock) { await record(context, parsedApproval.operationKey, hash, { state: 'uncertain' }); return finalBlock }
    checkBookingApproval(fresh, parsedApproval, now(), context.spendLimitMinor, finalAccess.connection!)
    await work.call(signal => context.adapter.submit({ booking: fresh, operationKey: parsedApproval.operationKey }, signal))
    const result = await work.call(signal => context.adapter.readReservation(parsedApproval.operationKey, signal)), checked = bookingReadback(draft, result, parsedApproval.operationKey)
    if (!checked.verified) { await record(context, parsedApproval.operationKey, hash, { state: 'uncertain' }); return uncertain() }
    if (!await record(context, parsedApproval.operationKey, hash, { state: 'verified', reservation: checked.reservation! })) return uncertain()
    return { state: 'verified', reservation: checked.reservation! }
  } catch (cause) {
    if (dispatched || claiming) { await record(context, parsedApproval.operationKey, hash, { state: 'uncertain' }); return uncertain() }
    if (cause instanceof BookingTakeoverRequired) return { state: 'takeover', reason: cause.reason, message: 'This site needs you to complete a protected step before booking can continue.' }
    return { state: 'needs_review', message: 'The booking could not be prepared safely. Check availability and review again.' }
  } finally { work.close() }
}
