import type { Config } from './config.js'
import type { Brain } from './llm.js'
import type { TTS } from './voice/tts.js'
import { Checkins, Events, KV, Messages, Observations, People, latestChangeAt } from './db.js'
import { refreshCalendar } from './calendar.js'
import { prepareCheckin } from './brain/prepare.js'
import { reflect, type ReflectResult } from './brain/reflect.js'
import { endCheckin } from './brain/extract.js'
import { worldForCheckin } from './brain/converse.js'
import { TITLES } from './prompts.js'
import { notify, playAloud } from './notify.js'
import { emit, hasConsoleOpen } from './bus.js'
import { addDays, addMinutes, atTime, dayKey, fmtTime, isQuiet, minutesBetween, startOfDay, ymd } from './time.js'
import type { Checkin, Status } from '../shared/types.js'

const TICK_MS = 30_000
const PREP_WINDOW_MIN = 45
const MISSED_AFTER_MIN = 180
const IDLE_END_MIN = 120

/** The clock. Runs every 30 seconds; does the small things itself and hands the expensive thinking to the brain when there is time and budget. */
export class Scheduler {
  preparing: string | null = null
  reflecting = false
  lastCalendarAt: string | null = null
  calendarErrors: string[] = []
  private busy = false
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly cfg: () => Config,
    readonly brain: Brain,
    readonly tts: TTS,
  ) {}

  get lastReflectAt(): string | null {
    return KV.get('last_reflect_at')
  }

  start(): void {
    void this.tick()
    this.timer = setInterval(() => void this.tick(), TICK_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      await this.maybeRefreshCalendar()
      this.ensureDailyCheckins()
      this.ensurePrepCheckins()
      this.touchPassedEvents()
      await this.expireStale()
      await this.fireDue()
      await this.prepareUpcoming()
      await this.maybeReflect()
      this.maybeOnboard()
    } catch (err) {
      console.error('[scheduler]', err)
    } finally {
      this.busy = false
    }
  }

  async maybeRefreshCalendar(force = false): Promise<void> {
    const cfg = this.cfg()
    const last = this.lastCalendarAt ? new Date(this.lastCalendarAt) : null
    if (!force && last && minutesBetween(last, new Date()) < cfg.calendar.refreshMinutes) return
    const res = await refreshCalendar(cfg)
    this.lastCalendarAt = new Date().toISOString()
    this.calendarErrors = res.errors
    for (const e of res.errors) console.warn(`[calendar] ${e}`)
  }

  ensureDailyCheckins(): void {
    const cfg = this.cfg()
    const now = new Date()
    for (const kind of ['morning', 'midday', 'evening'] as const) {
      const spec = cfg.checkins[kind]
      if (!spec.enabled) continue
      for (const offset of [0, 1]) {
        const day = addDays(startOfDay(now), offset)
        if (!spec.days.includes(dayKey(day))) continue
        const at = atTime(ymd(day), spec.time)
        if (minutesBetween(at, now) > 60) continue
        if (Checkins.findKindOnDay(kind, day)) continue
        const c = Checkins.create({ kind, title: TITLES[kind], scheduled_for: at.toISOString() })
        emit('checkin.scheduled', { checkin: c })
      }
    }
  }

  ensurePrepCheckins(): void {
    const cfg = this.cfg()
    const now = new Date()
    for (const ev of Events.between(now, addDays(now, 1))) {
      if (ev.all_day) continue
      if (cfg.checkins.prepOnlyWithAttendees && ev.attendees.length === 0) continue
      const start = new Date(ev.start)
      if (start < now) continue
      let at = addMinutes(start, -cfg.checkins.prepMinutesBefore)
      if (at < now) at = now
      const existing = Checkins.byEventAndKind(ev.id, 'prep')
      if (existing) {
        if ((existing.status === 'scheduled' || existing.status === 'prepared') && Math.abs(minutesBetween(new Date(existing.scheduled_for), at)) > 1 && at > now) {
          Checkins.reschedule(existing.id, at.toISOString())
          emit('checkin.scheduled', { checkin: Checkins.get(existing.id) })
        }
        continue
      }
      const c = Checkins.create({ kind: 'prep', event_id: ev.id, title: `Before: ${ev.title}`, scheduled_for: at.toISOString() })
      emit('checkin.scheduled', { checkin: c })
    }
    // Prep for meetings that vanished from the calendar.
    for (const c of Checkins.between(now, addDays(now, 2))) {
      if (c.kind === 'prep' && c.event_id && !Events.get(c.event_id) && (c.status === 'scheduled' || c.status === 'prepared')) {
        Checkins.setStatus(c.id, 'skipped', { summary: 'The meeting was removed from the calendar.' })
      }
    }
  }

  /** When a meeting ends, the attendees were just seen. */
  touchPassedEvents(): void {
    const now = new Date()
    const since = KV.get('touched_until') ? new Date(KV.get('touched_until')!) : addMinutes(now, -TICK_MS / 60_000 - 1)
    for (const ev of Events.between(since, now)) {
      if (new Date(ev.end) > now || new Date(ev.end) <= since) continue
      for (const a of ev.attendees) if (a.person_id) People.touch(a.person_id, ev.end)
    }
    KV.set('touched_until', now.toISOString())
  }

  async expireStale(): Promise<void> {
    const cfg = this.cfg()
    const now = new Date()
    for (const c of Checkins.allLive()) {
      const anchor = new Date(Messages.lastAt(c.id) ?? c.started_at ?? c.scheduled_for)
      const idle = minutesBetween(anchor, now)
      if (Messages.countUser(c.id) === 0 && idle > MISSED_AFTER_MIN) await endCheckin(cfg, this.brain, c, 'missed')
      else if (Messages.countUser(c.id) > 0 && idle > IDLE_END_MIN) await endCheckin(cfg, this.brain, c, 'done')
    }
    Observations.expire(now)
  }

  async fireDue(): Promise<void> {
    const cfg = this.cfg()
    const now = new Date()
    for (const c of Checkins.due(now)) {
      const late = minutesBetween(new Date(c.scheduled_for), now)
      if (c.kind === 'prep') {
        const ev = c.event_id ? Events.get(c.event_id) : undefined
        if (!ev || new Date(ev.start) < now) {
          Checkins.setStatus(c.id, 'skipped', { summary: 'The meeting had already started.' })
          continue
        }
      } else if (late > 60) {
        Checkins.setStatus(c.id, 'missed', { summary: `${cfg.assistant.name} was offline at ${fmtTime(c.scheduled_for)}.` })
        continue
      }
      await this.fire(c)
    }
  }

  private firing = new Map<string, Promise<Checkin>>()

  /** Start the conversation: end anything still open, say the opener, ping the Mac. Concurrent calls for the same conversation share one start. */
  fire(checkin: Checkin): Promise<Checkin> {
    const inFlight = this.firing.get(checkin.id)
    if (inFlight) return inFlight
    const p = this.fireOnce(checkin).finally(() => this.firing.delete(checkin.id))
    this.firing.set(checkin.id, p)
    return p
  }

  private async fireOnce(checkin: Checkin): Promise<Checkin> {
    const cfg = this.cfg()
    for (const live of Checkins.allLive()) {
      if (live.id === checkin.id) return live
      const lastAt = new Date(Messages.lastAt(live.id) ?? live.started_at ?? live.scheduled_for)
      const active = minutesBetween(lastAt, new Date()) < 10
      // A reminder or a requested word lands inside a conversation that is already going, instead of hanging up on it.
      if (checkin.kind === 'adhoc' && active) return this.deliverInto(live, checkin)
      if (Messages.countUser(live.id) > 0) {
        await endCheckin(cfg, this.brain, live, 'done')
      } else {
        Checkins.setStatus(live.id, live.kind === 'adhoc' ? 'skipped' : 'missed', { ended_at: new Date().toISOString(), summary: `Interrupted by ${checkin.title.toLowerCase()}.` })
        emit('checkin.ended', { checkin: Checkins.get(live.id) })
      }
    }
    let c = Checkins.get(checkin.id)!
    if (c.status === 'live') return c
    if (!c.script) {
      this.preparing = c.title
      emit('status', this.status())
      try {
        c = await prepareCheckin(cfg, this.brain, this.tts, c)
      } finally {
        this.preparing = null
      }
    }
    const script = c.script!
    c = Checkins.setStatus(c.id, 'live', { started_at: new Date().toISOString() })
    worldForCheckin(cfg, c)
    const message = Messages.add(c.id, 'assistant', script.opener, c.audio_path)
    Observations.markSurfaced(script.observation_ids)
    notify(`${cfg.assistant.name}: ${c.title}`, script.opener)
    if (cfg.notifications.speakAloud && c.audio_path && !hasConsoleOpen()) playAloud(c.audio_path)
    emit('checkin.live', { checkin: c, message })
    emit('status', this.status())
    return c
  }

  /** Say a due reminder inside the conversation that is already open, then close the reminder as delivered. */
  private async deliverInto(live: Checkin, due: Checkin): Promise<Checkin> {
    const cfg = this.cfg()
    let c = due
    if (!c.script) {
      this.preparing = c.title
      emit('status', this.status())
      try {
        c = await prepareCheckin(cfg, this.brain, this.tts, c)
      } finally {
        this.preparing = null
      }
    }
    const script = c.script!
    const message = Messages.add(live.id, 'assistant', script.opener, c.audio_path)
    Observations.markSurfaced(script.observation_ids)
    notify(`${cfg.assistant.name}: ${c.title}`, script.opener)
    if (cfg.notifications.speakAloud && c.audio_path && !hasConsoleOpen()) playAloud(c.audio_path)
    const now = new Date().toISOString()
    const done = Checkins.setStatus(c.id, 'done', { started_at: now, ended_at: now, summary: `Delivered during ${live.title.toLowerCase()}.` })
    emit('message', { checkinId: live.id, message })
    emit('checkin.ended', { checkin: done })
    emit('status', this.status())
    return live
  }

  /** A conversation the user opens by just talking. No opener; the first line is theirs. */
  openUserConversation(): Checkin {
    const cfg = this.cfg()
    const now = new Date().toISOString()
    let c = Checkins.create({ kind: 'adhoc', title: 'Conversation', scheduled_for: now, reason: `${cfg.user.name} started talking.` })
    c = Checkins.setStatus(c.id, 'live', { started_at: now })
    worldForCheckin(cfg, c)
    emit('checkin.live', { checkin: c, message: null })
    emit('status', this.status())
    return c
  }

  async prepareUpcoming(): Promise<void> {
    const cfg = this.cfg()
    const now = new Date()
    const [next] = Checkins.upcomingUnprepared(now, PREP_WINDOW_MIN)
    if (!next) return
    if (!this.brain.available && next.kind !== 'adhoc') {
      // Mock brain: still pre-render so the plumbing behaves the same.
    }
    this.preparing = next.title
    emit('status', this.status())
    try {
      await prepareCheckin(cfg, this.brain, this.tts, next)
    } finally {
      this.preparing = null
      emit('status', this.status())
    }
  }

  async maybeReflect(force = false): Promise<ReflectResult | null> {
    const cfg = this.cfg()
    if (!this.brain.available) return null
    const now = new Date()
    if (!force) {
      if (isQuiet(cfg, now)) return null
      if (Checkins.live()) return null
      const last = this.lastReflectAt ? new Date(this.lastReflectAt) : null
      if (last && minutesBetween(last, now) < cfg.thinking.intervalMinutes) return null
      const changed = latestChangeAt()
      const fresh = !last || (changed !== null && changed > last.toISOString()) || minutesBetween(last, now) > 180
      if (!fresh) return null
      if (this.brain.budgetLeft() <= 0) return null
    }
    this.reflecting = true
    emit('status', this.status())
    try {
      return await reflect(cfg, this.brain)
    } catch (err) {
      console.warn(`[reflect] ${(err as Error).message}`)
      return null
    } finally {
      this.reflecting = false
      emit('status', this.status())
    }
  }

  maybeOnboard(): void {
    if (!this.brain.available) return
    if (KV.get('onboarded') || KV.get('onboarding_created')) return
    if (People.all().length > 3) {
      KV.set('onboarded', '1')
      return
    }
    const c = Checkins.create({ kind: 'onboarding', title: TITLES.onboarding, scheduled_for: addMinutes(new Date(), 1).toISOString(), reason: 'Getting to know each other.' })
    KV.set('onboarding_created', '1')
    emit('checkin.scheduled', { checkin: c })
  }

  status(): Status {
    const cfg = this.cfg()
    const now = new Date()
    const live = Checkins.live()
    const queued = Observations.queued().filter((o) => o.surface_when !== 'never').length
    const base = { preparing: this.preparing, reflecting: this.reflecting, lastReflectAt: this.lastReflectAt, lastCalendarAt: this.lastCalendarAt, calendarErrors: this.calendarErrors, queued }
    if (live) {
      const event = live.event_id ? Events.get(live.event_id) : undefined
      const headline =
        live.kind === 'prep' && event ? `Before ${event.title}.`
        : live.kind === 'adhoc' && !live.script ? "I'm listening."
        : live.kind === 'adhoc' ? 'Talking.'
        : live.kind === 'onboarding' ? 'Getting acquainted.'
        : `In your ${live.title.toLowerCase()}.`
      return { ...base, headline, detail: 'End the conversation when you are done.' }
    }
    if (this.preparing) return { ...base, headline: `Preparing ${this.preparing.toLowerCase()}.`, detail: 'Reading through what I have.' }
    if (this.reflecting) return { ...base, headline: 'Thinking.', detail: 'Reading the next two days.' }
    const next = Checkins.next(now)
    if (next) {
      const sameDay = ymd(new Date(next.scheduled_for)) === ymd(now)
      const when = sameDay ? fmtTime(next.scheduled_for) : `${fmtTime(next.scheduled_for)} tomorrow`
      const detail = queued
        ? `${queued} thing${queued === 1 ? '' : 's'} noted for then.`
        : this.brain.available
          ? this.lastReflectAt
            ? `Nothing worth interrupting you with since ${fmtTime(this.lastReflectAt)}.`
            : 'Nothing noted yet.'
          : 'Running without a brain. Add an API key to change that.'
      return { ...base, headline: `${next.title} at ${when}.`, detail }
    }
    return { ...base, headline: 'Nothing scheduled.', detail: cfg.calendar.icsUrls.length ? 'Watching the calendar.' : 'No calendar connected yet.' }
  }
}
