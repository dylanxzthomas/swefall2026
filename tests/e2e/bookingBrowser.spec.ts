import { test, expect, type BrowserContext } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { bookingHash, type BookingApproval, type BookingDraft } from '../../shared/booking'
import { executeBooking, type BookingConnection, type BookingWorkflowContext } from '../../shared/bookingWorkflow'
import { startSyntheticBookingSite, syntheticBookingAdapter, memoryBookingCheckpoints } from '../fixtures/booking-site'

async function approveInTestReview(context: BrowserContext, draft: BookingDraft, connection: BookingConnection): Promise<BookingApproval> {
  const review = await context.newPage()
  let approved: BookingApproval | undefined
  await review.exposeFunction('approveSyntheticBooking', () => { approved = { draftHash: bookingHash(draft), operationKey: randomUUID(), approvedAt: Date.now(), connectionId: connection.id, connectionVersion: connection.version } })
  await review.setContent('<h1>Synthetic booking approval test</h1><p>This tests a local venue. No real reservation or charge will occur.</p><pre id="details"></pre><button>Approve this exact booking</button>')
  await review.locator('#details').evaluate((element, booking) => { element.textContent = `${booking.venue}\n${booking.service}\n${booking.date} ${booking.startTime} ${booking.timezone}\n${booking.participants} participants\n$${(booking.priceMinor / 100).toFixed(2)} ${booking.currency}\n${booking.cancellationTerms}\n${booking.accountLabel}` }, draft)
  await review.evaluate(() => { document.querySelector('button')!.addEventListener('click', () => { void (window as unknown as { approveSyntheticBooking(): Promise<void> }).approveSyntheticBooking() }) })
  await review.getByRole('button', { name: 'Approve this exact booking' }).click()
  await expect.poll(() => !!approved).toBe(true)
  await review.close(); return approved!
}

test('browser booking inspects a real local site, waits for exact review, and verifies a persisted reservation', async ({ page, context }) => {
  const site = await startSyntheticBookingSite()
  try {
    await page.goto(site.origin)
    await expect(page.getByRole('heading', { name: 'Activity availability' })).toBeVisible()
    const morning = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Family pottery · 10:00' }) })
    await morning.getByLabel('Participants').fill('2'); await morning.getByRole('button', { name: 'View 10:00 quote' }).click()
    await expect(page.getByRole('heading', { name: 'Review activity booking' })).toBeVisible(); await expect(page.getByText('$40.00 USD', { exact: true })).toBeVisible()
    const adapter = syntheticBookingAdapter(page, site), draft = await adapter.inspect({ slotId: 'pottery-morning', participants: 2, childId: null }, new AbortController().signal)
    const connection: BookingConnection = { id: 'synthetic-private-profile', version: 1, site: 'synthetic_activity', accountLabel: site.accountLabel, state: 'ready' }
    const checkpoints = memoryBookingCheckpoints(), workflow: BookingWorkflowContext = { adapter, checkpoints, readAccess: async () => ({ cancelled: false, connection }), spendLimitMinor: 5000 }
    expect(await executeBooking(workflow, draft, null)).toMatchObject({ state: 'needs_review' }); expect(site.submissionCount()).toBe(0); expect(site.reservations()).toEqual([])
    const approval = await approveInTestReview(context, draft, connection), result = await executeBooking(workflow, draft, approval)
    expect(result.state).toBe('verified'); expect(site.submissionCount()).toBe(1); expect(site.reservations()).toHaveLength(1)
    expect(site.reservations()[0]).toMatchObject({ operationKey: approval.operationKey, draftHash: approval.draftHash, booking: { participants: 2, priceMinor: 4000 } })
    await expect(page.getByRole('heading', { name: 'Reservation confirmed' })).toBeVisible()
    expect(checkpoints.snapshot()).toMatchObject([{ state: 'verified', operationKey: approval.operationKey }])
    expect((await executeBooking(workflow, draft, approval)).state).toBe('verified'); expect(site.submissionCount()).toBe(1)
  } finally { await site.close() }
})

test('changed prices and terms need another review; changed connections or takeover never submit', async ({ page, context }) => {
  const site = await startSyntheticBookingSite()
  try {
    const adapter = syntheticBookingAdapter(page, site), draft = await adapter.inspect({ slotId: 'pottery-morning', participants: 2, childId: null }, new AbortController().signal)
    let connection: BookingConnection = { id: 'synthetic-private-profile', version: 1, site: 'synthetic_activity', accountLabel: site.accountLabel, state: 'ready' }
    const checkpoints = memoryBookingCheckpoints(), workflow: BookingWorkflowContext = { adapter, checkpoints, readAccess: async () => ({ cancelled: false, connection }), spendLimitMinor: 10000 }
    const approval = await approveInTestReview(context, draft, connection)
    site.changeSlot('pottery-morning', { unitPriceMinor: 2500, cancellationTerms: 'No refunds within 48 hours.' })
    const changed = await executeBooking(workflow, draft, approval)
    expect(changed).toMatchObject({ state: 'needs_review', changes: expect.arrayContaining(['priceMinor', 'cancellationTerms', 'quoteVersion']) })
    connection = { ...connection, version: 2 }
    expect(await executeBooking(workflow, draft, approval)).toMatchObject({ state: 'needs_review' })
    connection = { ...connection, state: 'revoked' }
    expect(await executeBooking(workflow, draft, approval)).toMatchObject({ state: 'connection_needed' })
    connection = { ...connection, state: 'takeover_required' }
    expect(await executeBooking(workflow, draft, approval)).toMatchObject({ state: 'takeover', reason: 'login' })
    expect(site.submissionCount()).toBe(0); expect(site.reservations()).toEqual([]); expect(checkpoints.snapshot()).toEqual([])
  } finally { await site.close() }
})

test('an interrupted response after the booking commits reconciles in a new browser without another submission', async ({ page, context }) => {
  const site = await startSyntheticBookingSite()
  try {
    const adapter = syntheticBookingAdapter(page, site), draft = await adapter.inspect({ slotId: 'pottery-morning', participants: 1, childId: null }, new AbortController().signal)
    const connection: BookingConnection = { id: 'synthetic-private-profile', version: 1, site: 'synthetic_activity', accountLabel: site.accountLabel, state: 'ready' }
    const checkpoints = memoryBookingCheckpoints(), workflow: BookingWorkflowContext = { adapter, checkpoints, readAccess: async () => ({ cancelled: false, connection }), spendLimitMinor: 5000 }
    const approval = await approveInTestReview(context, draft, connection)
    site.interruptNextSubmit()
    expect((await executeBooking(workflow, draft, approval)).state).toBe('uncertain')
    expect(site.reservations()).toHaveLength(1); expect(site.submissionCount()).toBe(1); expect(checkpoints.snapshot()[0].state).toBe('uncertain')
    await page.close(); const resumed = await context.newPage()
    const result = await executeBooking({ ...workflow, adapter: syntheticBookingAdapter(resumed, site) }, draft, approval)
    expect(result.state).toBe('verified'); expect(site.submissionCount()).toBe(1); expect(site.reservations()).toHaveLength(1)
    await expect(resumed.getByRole('heading', { name: 'Reservation confirmed' })).toBeVisible(); await resumed.close()
  } finally { await site.close() }
})

test('two browser workers sharing one operation cannot both submit or downgrade its verified receipt', async ({ page, context }) => {
  const site = await startSyntheticBookingSite()
  try {
    const adapter = syntheticBookingAdapter(page, site), draft = await adapter.inspect({ slotId: 'pottery-morning', participants: 1, childId: null }, new AbortController().signal)
    const connection: BookingConnection = { id: 'synthetic-private-profile', version: 1, site: 'synthetic_activity', accountLabel: site.accountLabel, state: 'ready' }
    const checkpoints = memoryBookingCheckpoints(), workflow: BookingWorkflowContext = { adapter, checkpoints, readAccess: async () => ({ cancelled: false, connection }), spendLimitMinor: 5000 }
    const approval = await approveInTestReview(context, draft, connection), otherPage = await context.newPage()
    const results = await Promise.all([executeBooking(workflow, draft, approval), executeBooking({ ...workflow, adapter: syntheticBookingAdapter(otherPage, site) }, draft, approval)])
    expect(results.some(result => result.state === 'verified')).toBe(true); expect(site.submissionCount()).toBe(1); expect(site.reservations()).toHaveLength(1); expect(checkpoints.snapshot()[0].state).toBe('verified')
    await otherPage.close()
  } finally { await site.close() }
})
