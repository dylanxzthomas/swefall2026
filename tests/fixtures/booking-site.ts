import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { bookingHash, bookingSchema, type BookingDraft, type BookingReservation } from '../../shared/booking.js'
import { BookingTakeoverRequired, type BookingCheckpoint, type BookingCheckpointStore, type BookingSiteAdapter } from '../../shared/bookingWorkflow.js'

type Slot = { slotId: string; venue: string; service: string; date: string; startTime: string; timezone: string; unitPriceMinor: number; cancellationTerms: string; quoteVersion: number; expiresAt: number; available: boolean }
const escape = (value: unknown) => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
const json = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c')
const pageHtml = (body: string) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic activity venue</title><style>body{font:17px system-ui;line-height:1.5;max-width:640px;margin:32px auto;padding:20px;color:#242424;background:#fffaf3}dt{font-weight:600}dd{margin:0 0 12px}button,a{font:inherit;padding:10px}input{font:inherit;padding:8px}small{display:block;color:#6c5a45}</style><body><small>Local synthetic test venue · no real bookings or charges</small>${body}</body></html>`
const knownSites = new WeakSet<object>()
export type SyntheticBookingSite = {
  readonly origin: string; readonly accountLabel: string;
  reservations(): BookingReservation[]; submissionCount(): number;
  changeSlot(slotId: string, changes: Partial<Omit<Slot, 'slotId' | 'quoteVersion'>>): void;
  interruptNextSubmit(): void;
  close(): Promise<void>;
}

/** Controls are process-owned methods, never remotely callable administration endpoints. */
export async function startSyntheticBookingSite(): Promise<SyntheticBookingSite> {
  const accountLabel = 'Synthetic Rivera parent', expiry = Date.now() + 3600_000
  const slots: Slot[] = [
    { slotId: 'pottery-morning', venue: 'Synthetic Activity Studio', service: 'Family pottery', date: '2027-05-08', startTime: '10:00', timezone: 'America/Los_Angeles', unitPriceMinor: 2000, cancellationTerms: 'Cancel at least 24 hours before for a full refund.', quoteVersion: 1, expiresAt: expiry, available: true },
    { slotId: 'pottery-afternoon', venue: 'Synthetic Activity Studio', service: 'Family pottery', date: '2027-05-08', startTime: '14:00', timezone: 'America/Los_Angeles', unitPriceMinor: 2000, cancellationTerms: 'Cancel at least 24 hours before for a full refund.', quoteVersion: 1, expiresAt: expiry, available: true },
  ]
  const reservations = new Map<string, BookingReservation>()
  let submissions = 0, interrupt = false
  function quote(slotId: string, participants: number, childId: string | null): BookingDraft {
    const slot = slots.find(slot => slot.slotId === slotId)
    if (!slot?.available) throw new Error('This activity slot is unavailable.')
    return bookingSchema.parse({ kind: 'booking', childId, site: 'synthetic_activity', venue: slot.venue, service: slot.service, slotId: slot.slotId, date: slot.date, startTime: slot.startTime, timezone: slot.timezone, participants, priceMinor: participants * slot.unitPriceMinor, currency: 'USD', cancellationTerms: slot.cancellationTerms, accountLabel, quoteVersion: slot.quoteVersion, expiresAt: slot.expiresAt, evidence: { service: slot.service, price: `$${(participants * slot.unitPriceMinor / 100).toFixed(2)} total`, cancellation: slot.cancellationTerms } })
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const send = (body: string, status = 200) => { response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" }); response.end(pageHtml(body)) }
    const showReservation = (reservation: BookingReservation | undefined) => reservation ? send(`<h1>Reservation confirmed</h1><p>Confirmation ${escape(reservation.reservationId)}</p><p>${escape(reservation.booking.service)} · ${escape(reservation.booking.date)} ${escape(reservation.booking.startTime)} · ${reservation.booking.participants} participants</p><script id="reservation-receipt" type="application/json">${json(reservation)}</script>`) : send('<h1>No confirmed reservation found</h1>')
    try {
      if (request.method === 'GET' && url.pathname === '/') {
        send(`<h1>Activity availability</h1><p>Account: ${escape(accountLabel)}</p>${slots.map(slot => `<section><h2>${escape(slot.service)} · ${escape(slot.startTime)}</h2><p>${escape(slot.date)} · $${(slot.unitPriceMinor / 100).toFixed(2)} per participant</p>${slot.available ? `<form action="/booking" method="get"><input type="hidden" name="slotId" value="${escape(slot.slotId)}"><label>Participants<input name="participants" type="number" min="1" max="10" value="1"></label><button type="submit">View ${escape(slot.startTime)} quote</button></form>` : '<p>Unavailable</p>'}</section>`).join('')}`); return
      }
      if (request.method === 'GET' && url.pathname === '/booking') {
        const draft = quote(url.searchParams.get('slotId') ?? '', Number(url.searchParams.get('participants')), url.searchParams.get('childId') || null)
        send(`<h1>Review activity booking</h1><dl>${Object.entries({ Venue: draft.venue, Activity: draft.service, Date: draft.date, Time: `${draft.startTime} ${draft.timezone}`, Participants: draft.participants, 'Total price': `$${(draft.priceMinor / 100).toFixed(2)} ${draft.currency}`, Cancellation: draft.cancellationTerms, Account: draft.accountLabel }).map(([key, value]) => `<dt>${key}</dt><dd>${escape(value)}</dd>`).join('')}</dl><form method="post" action="/reservations"><input type="hidden" name="slotId" value="${escape(draft.slotId)}"><input type="hidden" name="participants" value="${draft.participants}"><input type="hidden" name="childId" value="${escape(draft.childId ?? '')}"><input type="hidden" name="quoteHash" value="${bookingHash(draft)}"><input type="hidden" name="operationKey" value=""><button type="submit">Book activity</button></form><script id="booking-quote" type="application/json">${json(draft)}</script>`); return
      }
      if (request.method === 'GET' && url.pathname === '/reservations') { showReservation(reservations.get(url.searchParams.get('operationKey') ?? '')); return }
      if (request.method === 'GET' && url.pathname.startsWith('/reservation/')) { showReservation([...reservations.values()].find(value => value.reservationId === url.pathname.slice('/reservation/'.length))); return }
      if (request.method === 'POST' && url.pathname === '/reservations') {
        submissions++
        let body = ''
        for await (const chunk of request) { body += String(chunk); if (body.length > 4096) { send('<h1>Request too large</h1>', 413); return } }
        const form = new URLSearchParams(body), operationKey = form.get('operationKey') ?? '', expectedHash = form.get('quoteHash') ?? ''
        if (!/^[a-zA-Z0-9_-]{16,100}$/.test(operationKey)) { send('<h1>A booking operation is required</h1>', 400); return }
        const previous = reservations.get(operationKey)
        if (previous) {
          if (previous.draftHash !== expectedHash) { send('<h1>This operation already belongs to another quote</h1>', 409); return }
          response.writeHead(303, { Location: `/reservation/${previous.reservationId}` }); response.end(); return
        }
        const current = quote(form.get('slotId') ?? '', Number(form.get('participants')), form.get('childId') || null)
        if (current.expiresAt <= Date.now() || bookingHash(current) !== expectedHash) { send('<h1>Quote changed or expired. Review it again.</h1>', 409); return }
        const reservation: BookingReservation = { reservationId: `test_${randomUUID()}`, status: 'confirmed', operationKey, accountLabel, draftHash: expectedHash, booking: current }
        reservations.set(operationKey, reservation)
        if (interrupt) {
          interrupt = false
          // Commit, then stall a started response. A bare socket reset may cause Chrome
          // itself to retry a form POST before receiving any response bytes.
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
          response.write('<!doctype html><html><body>Waiting for the synthetic confirmation…')
          return
        }
        response.writeHead(303, { Location: `/reservation/${reservation.reservationId}` }); response.end(); return
      }
      send('<h1>Page unavailable</h1>', 404)
    } catch { send('<h1>This slot or request is unavailable</h1>', 409) }
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() }) })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const fixture: SyntheticBookingSite = { origin, accountLabel, reservations: () => structuredClone([...reservations.values()]), submissionCount: () => submissions,
    changeSlot(slotId, changes) { const slot = slots.find(slot => slot.slotId === slotId); if (!slot) throw new Error('Unknown synthetic slot.'); Object.assign(slot, changes, { quoteVersion: slot.quoteVersion + 1 }) },
    interruptNextSubmit() { interrupt = true },
    async close() { knownSites.delete(fixture); await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() }) },
  }
  Object.freeze(fixture); knownSites.add(fixture); return fixture
}

/** Site-specific test adapter: no arbitrary URLs, page scripts, credentials or paid provider. */
export function syntheticBookingAdapter(page: Page, site: SyntheticBookingSite): BookingSiteAdapter {
  const allowed = () => { if (!knownSites.has(site) || !/^http:\/\/127\.0\.0\.1:\d+$/.test(site.origin)) throw new Error('Unknown synthetic site instance.') }
  const check = (signal: AbortSignal) => { allowed(); if (signal.aborted) throw new Error('Browser step stopped.'); if (new URL(page.url()).origin !== site.origin) throw new BookingTakeoverRequired('unsupported_page') }
  return { site: 'synthetic_activity',
    async inspect(request, signal) {
      allowed(); if (signal.aborted) throw new Error('Browser step stopped.')
      const url = new URL('/booking', site.origin); url.searchParams.set('slotId', request.slotId); url.searchParams.set('participants', String(request.participants)); if (request.childId) url.searchParams.set('childId', request.childId)
      const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 3000 }); check(signal)
      if (!response?.ok()) throw new Error('The activity is unavailable.')
      return bookingSchema.parse(JSON.parse(await page.locator('#booking-quote').textContent() ?? 'null'))
    },
    async submit({ booking, operationKey }, signal) {
      check(signal)
      const rendered = bookingSchema.parse(JSON.parse(await page.locator('#booking-quote').textContent() ?? 'null'))
      if (bookingHash(rendered) !== bookingHash(booking)) throw new Error('The displayed quote changed.')
      await page.locator('input[name="operationKey"]').evaluate((element, value) => { (element as HTMLInputElement).value = value }, operationKey)
      check(signal)
      const [response] = await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 3000 }), page.getByRole('button', { name: 'Book activity', exact: true }).click({ timeout: 3000 })])
      check(signal); if (!response?.ok()) throw new Error('The submission has no verified success response.')
    },
    async readReservation(operationKey, signal) {
      allowed(); if (signal.aborted) throw new Error('Browser step stopped.')
      const url = new URL('/reservations', site.origin); url.searchParams.set('operationKey', operationKey)
      const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 3000 }); check(signal)
      if (!response?.ok()) throw new Error('The existing reservation could not be read.')
      const receipt = page.locator('#reservation-receipt')
      return await receipt.count() ? JSON.parse(await receipt.textContent() ?? 'null') : null
    },
  }
}

/** Test implementation only; product integration must supply transactional durable records. */
export function memoryBookingCheckpoints(): BookingCheckpointStore & { snapshot(): BookingCheckpoint[] } {
  const records = new Map<string, BookingCheckpoint>()
  return { async read(key) { return structuredClone(records.get(key) ?? null) }, async claim(value) { if (records.has(value.operationKey)) return false; records.set(value.operationKey, structuredClone(value)); return true },
    async settle(key, hash, result) { const existing = records.get(key); if (!existing || existing.draftHash !== hash) throw new Error('Checkpoint changed.'); if (existing.state === 'verified') return; records.set(key, { ...existing, ...structuredClone(result) }) }, snapshot: () => structuredClone([...records.values()]) }
}
