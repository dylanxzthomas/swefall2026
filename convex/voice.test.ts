import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import schema from './schema'
import { api, internal } from './_generated/api'
import { voiceLimits } from '../shared/voice'
const modules = import.meta.glob('./**/*.ts'), now = Date.parse('2026-10-14T18:00:00Z')
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv('OPENAI_API_KEY', 'synthetic-test-key'); vi.stubEnv('DAYMARK_VOICE_MODEL', 'gpt-realtime-2.1') })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs() })
async function fixture() {
  const t = convexTest(schema, modules); workflow.register(t)
  const parent = t.withIdentity({ subject: 'parent', tokenIdentifier: 'test|parent' }), other = t.withIdentity({ subject: 'other', tokenIdentifier: 'test|other' })
  const householdId = await parent.mutation(api.households.save, { timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }] })
  await t.run(ctx => ctx.db.insert('memberships', { householdId, subject: 'test|other', role: 'adult' }))
  const reserve = (requestId = 'synthetic-request') => parent.mutation(api.voice.reserve, { requestId, consent: true })
  return { t, parent, other, householdId, reserve }
}
it('requires signed-in confirmed identity and explicitly configured live voice', async () => {
  const f = await fixture()
  await expect(f.t.query(api.voice.settings, {})).rejects.toThrow('Sign in')
  expect(await f.parent.query(api.voice.settings, {})).toEqual({ configured: true, model: 'gpt-realtime-2.1' })
  vi.stubEnv('OPENAI_API_KEY', '')
  expect(await f.parent.query(api.voice.settings, {})).toEqual({ configured: false })
  await expect(f.reserve()).rejects.toThrow('not configured')
})
it('coalesces 50 simultaneous requests before spending on a provider session and blocks concurrent calls', async () => {
  const f = await fixture(), starts = await Promise.all(Array.from({ length: 50 }, () => f.reserve()))
  expect(starts.filter(Boolean)).toHaveLength(1)
  expect(await f.t.run(ctx => ctx.db.query('voiceSessions').collect())).toHaveLength(1)
  await expect(f.reserve('different-request')).rejects.toThrow('Stop your current')
  expect(await f.other.query(api.voice.settings, {})).toEqual({ configured: true, model: 'gpt-realtime-2.1' })
})
it('binds provider startup and stop to the private owner without exposing the trusted provider call ID', async () => {
  const f = await fixture(), reservation = (await f.reserve())!, identity = { id: reservation.id, version: reservation.version }
  expect(await f.t.query(internal.voice.permitted, identity)).toBe(true)
  expect(await f.t.mutation(internal.voice.started, { ...identity, providerCallId: 'rtc_synthetic' })).toBe(true)
  expect(await f.parent.query(api.voice.settings, {})).toMatchObject({ active: { ...identity, status: 'active' } })
  expect(JSON.stringify(await f.parent.query(api.voice.settings, {}))).not.toMatch(/rtc_synthetic|synthetic-test-key|transcript|audio/)
  await expect(f.other.mutation(api.voice.stop, identity)).rejects.toThrow('unavailable')
  expect(await f.parent.mutation(api.voice.stop, identity)).toBe(2)
  expect(await f.parent.mutation(api.voice.stop, identity)).toBe(2)
  expect(await f.t.query(internal.voice.permitted, identity)).toBe(false)
  for (const table of ['jobs', 'sources', 'actions', 'approvals', 'attempts', 'mailDrafts'] as const) expect(await f.t.run(ctx => ctx.db.query(table).collect())).toEqual([])
})
it('rejects late startup after stop, setup expiry or membership removal', async () => {
  for (const mode of ['stop', 'expiry', 'membership'] as const) {
    const f = await fixture(), reservation = (await f.reserve())!, identity = { id: reservation.id, version: 1 }
    if (mode === 'stop') await f.parent.mutation(api.voice.stop, identity)
    if (mode === 'expiry') vi.setSystemTime(now + voiceLimits.setupMs + 1)
    if (mode === 'membership') await f.t.run(async ctx => { const m = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', 'test|parent')).unique(); await ctx.db.delete(m!._id) })
    expect(await f.t.query(internal.voice.permitted, identity)).toBe(false)
    expect(await f.t.mutation(internal.voice.started, { ...identity, providerCallId: 'rtc_synthetic' })).toBe(false)
    vi.setSystemTime(now)
  }
})
it('terminates eligibility after ten minutes and keeps failed-closure feedback honest', async () => {
  const f = await fixture(), reservation = (await f.reserve())!, identity = { id: reservation.id, version: 1 }
  await f.t.mutation(internal.voice.started, { ...identity, providerCallId: 'rtc_synthetic' })
  vi.setSystemTime(now + voiceLimits.sessionMs + 1)
  expect(await f.t.query(internal.voice.permitted, identity)).toBe(false)
  await f.t.mutation(internal.voice.ended, { id: reservation.id, providerCallId: 'rtc_synthetic', confirmed: false })
  expect((await f.t.run(ctx => ctx.db.get(reservation.id)))?.issue).toContain('closure could not be confirmed')
  await f.t.mutation(internal.voice.ended, { id: reservation.id, providerCallId: 'rtc_synthetic', confirmed: true })
  expect(await f.t.run(ctx => ctx.db.get(reservation.id))).toMatchObject({status:'stopped'});expect((await f.t.run(ctx => ctx.db.get(reservation.id)))?.providerCallId).toBeUndefined();expect((await f.t.run(ctx => ctx.db.get(reservation.id)))?.issue).toBeUndefined()
})
it('bounds provider starts per owner and permits a later hour without preserving call content', async () => {
  const f = await fixture()
  for (let i = 0; i < voiceLimits.startsPerHour; i++) { const row = (await f.reserve(`synthetic-${i}`))!; await f.parent.mutation(api.voice.stop, { id: row.id, version: row.version }) }
  await expect(f.reserve('one-too-many')).rejects.toThrow('usage limit')
  vi.setSystemTime(now + 3600_000 + 1)
  expect(await f.reserve('next-hour')).not.toBeNull()
})
