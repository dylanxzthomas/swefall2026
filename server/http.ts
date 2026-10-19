import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import { householdApp } from './household/http.js'
import { streamSSE } from 'hono/streaming'
import { serveStatic } from '@hono/node-server/serve-static'
import type { Config } from './config.js'
import { AUDIO_DIR, DATA_DIR, LOCAL_CALENDAR_PATH, PROFILE_PATH, env, icsUrls, saveConfig } from './config.js'
import type { Brain } from './llm.js'
import type { TTS } from './voice/tts.js'
import type { STT } from './voice/stt.js'
import type { Scheduler } from './scheduler.js'
import { Checkins, Commitments, Events, Facts, Messages, Notes, Observations, People, Tasks, Usage } from './db.js'
import { bus, clientConnected, clientDisconnected, type BusEvent } from './bus.js'
import { respond } from './brain/converse.js'
import { endCheckin } from './brain/extract.js'
import { readProfile, writeProfile } from './profile.js'
import { addDays, addMinutes, startOfDay, ymd } from './time.js'
import type { MemoryDTO, PersonDetail, Providers, SettingsDTO, StateDTO } from '../shared/types.js'

export interface Deps {
  cfg: () => Config
  brain: Brain
  tts: TTS
  stt: STT
  scheduler: Scheduler
}

function providers(d: Deps): Providers {
  const cfg = d.cfg()
  return {
    brain: d.brain.available ? 'claude' : 'mock',
    model: cfg.assistant.model,
    tts: d.tts.provider,
    stt: d.stt.provider,
    calendarFeeds: icsUrls(cfg).length,
  }
}

function usageToday(d: Deps) {
  const u = Usage.today(ymd(new Date()))
  return { costUsd: u.cost, calls: u.calls, budgetUsd: d.cfg().thinking.dailyBudgetUsd }
}

export function buildState(d: Deps): StateDTO {
  const cfg = d.cfg()
  const now = new Date()
  const dayStart = startOfDay(now)
  const tomorrow = addDays(dayStart, 1)
  const dayAfter = addDays(dayStart, 2)
  const live = Checkins.live() ?? null
  return {
    assistant: { name: cfg.assistant.name },
    user: { name: cfg.user.name },
    providers: providers(d),
    status: d.scheduler.status(),
    live,
    messages: live ? Messages.forCheckin(live.id) : [],
    tasks: live ? Tasks.forCheckin(live.id) : Tasks.recent(5),
    today: { checkins: Checkins.between(dayStart, tomorrow), events: Events.between(dayStart, tomorrow) },
    tomorrow: { checkins: Checkins.between(tomorrow, dayAfter), events: Events.between(tomorrow, dayAfter) },
    surfaced: Observations.surfacedSince(dayStart),
    usageToday: usageToday(d),
    now: now.toISOString(),
  }
}

const audioUrl = (p: string | null) => (p ? `/audio/${path.basename(p)}` : null)

export function createApp(d: Deps) {
  const app = new Hono()
  app.route('/api/household', householdApp(d.brain))

  app.onError((err, c) => {
    console.error('[http]', err)
    return c.json({ error: err.message }, 500)
  })

  // ----- live state -----
  app.get('/api/state', (c) => c.json(buildState(d)))

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      clientConnected()
      let open = true
      const onEvent = (evt: BusEvent) => {
        if (!open) return
        void stream.writeSSE({ event: evt.type, data: JSON.stringify(evt.data ?? {}), id: evt.at })
      }
      bus.on('event', onEvent)
      stream.onAbort(() => {
        open = false
        bus.off('event', onEvent)
        clientDisconnected()
      })
      await stream.writeSSE({ event: 'hello', data: JSON.stringify({ now: new Date().toISOString() }) })
      while (open) {
        await stream.sleep(15_000)
        if (open) await stream.writeSSE({ event: 'ping', data: '{}' })
      }
    }),
  )

  // ----- conversations -----
  app.get('/api/checkins', (c) => {
    const from = c.req.query('from') ? new Date(c.req.query('from')!) : addDays(startOfDay(new Date()), -7)
    const to = c.req.query('to') ? new Date(c.req.query('to')!) : addDays(startOfDay(new Date()), 2)
    return c.json(Checkins.between(from, to))
  })

  app.get('/api/checkins/:id', (c) => {
    const ck = Checkins.get(c.req.param('id'))
    if (!ck) return c.json({ error: 'not found' }, 404)
    return c.json({ checkin: ck, messages: Messages.forCheckin(ck.id), tasks: Tasks.forCheckin(ck.id) })
  })

  app.post('/api/checkins', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string; title?: string; in_minutes?: number }
    const reason = (body.reason ?? '').trim() || 'You asked to talk.'
    const mins = Number.isFinite(body.in_minutes) ? Math.max(0, Number(body.in_minutes)) : 0
    const at = mins > 0 ? addMinutes(new Date(), mins) : new Date()
    let ck = Checkins.create({ kind: 'adhoc', title: (body.title ?? '').trim() || 'Conversation', scheduled_for: at.toISOString(), reason })
    if (mins === 0) ck = await d.scheduler.fire(ck)
    return c.json({ checkin: ck, messages: Messages.forCheckin(ck.id) })
  })

  app.post('/api/checkins/:id/start', async (c) => {
    const ck = Checkins.get(c.req.param('id'))
    if (!ck) return c.json({ error: 'not found' }, 404)
    if (ck.status !== 'scheduled' && ck.status !== 'prepared' && ck.status !== 'live') return c.json({ error: `cannot start a ${ck.status} conversation` }, 400)
    const live = await d.scheduler.fire(ck)
    return c.json({ checkin: live, messages: Messages.forCheckin(live.id) })
  })

  // Say something with no conversation open: one is opened on the spot, with no opener, and this is its first line.
  app.post('/api/say', async (c) => {
    const body = (await c.req.json()) as { text?: string; via?: 'voice' | 'text' }
    const text = (body.text ?? '').trim()
    if (!text) return c.json({ error: 'nothing said' }, 400)
    const live = Checkins.live() ?? d.scheduler.openUserConversation()
    const out = await respond(d.cfg(), d.brain, d.tts, live, text, body.via === 'voice' ? 'voice' : 'text')
    return c.json({ checkin: Checkins.get(live.id), ...out })
  })

  app.post('/api/checkins/:id/say', async (c) => {
    const ck = Checkins.get(c.req.param('id'))
    if (!ck) return c.json({ error: 'not found' }, 404)
    if (ck.status !== 'live') return c.json({ error: 'this conversation is not live' }, 400)
    const body = (await c.req.json()) as { text?: string; via?: 'voice' | 'text' }
    const text = (body.text ?? '').trim()
    if (!text) return c.json({ error: 'nothing said' }, 400)
    const out = await respond(d.cfg(), d.brain, d.tts, ck, text, body.via === 'voice' ? 'voice' : 'text')
    return c.json(out)
  })

  app.post('/api/checkins/:id/end', async (c) => {
    const ck = Checkins.get(c.req.param('id'))
    if (!ck) return c.json({ error: 'not found' }, 404)
    if (ck.status !== 'live') return c.json({ checkin: ck })
    const ended = await endCheckin(d.cfg(), d.brain, ck, Messages.countUser(ck.id) > 0 ? 'done' : 'missed')
    return c.json({ checkin: ended })
  })

  app.post('/api/checkins/:id/skip', async (c) => {
    const ck = Checkins.get(c.req.param('id'))
    if (!ck) return c.json({ error: 'not found' }, 404)
    if (ck.status === 'live') return c.json({ checkin: await endCheckin(d.cfg(), d.brain, ck, 'skipped') })
    if (ck.status === 'scheduled' || ck.status === 'prepared') return c.json({ checkin: Checkins.setStatus(ck.id, 'skipped', { summary: 'Skipped.' }) })
    return c.json({ checkin: ck })
  })

  app.post('/api/observations/:id/dismiss', (c) => {
    const o = Observations.get(c.req.param('id'))
    if (!o) return c.json({ error: 'not found' }, 404)
    Observations.setStatus(o.id, 'dismissed')
    return c.json({ ok: true })
  })

  app.post('/api/think', async (c) => {
    const res = await d.scheduler.maybeReflect(true)
    return c.json({ result: res, status: d.scheduler.status() })
  })

  app.post('/api/calendar/refresh', async (c) => {
    await d.scheduler.maybeRefreshCalendar(true)
    d.scheduler.ensurePrepCheckins()
    return c.json({ at: d.scheduler.lastCalendarAt, errors: d.scheduler.calendarErrors })
  })

  // ----- speech -----
  app.post('/api/stt', async (c) => {
    const body = await c.req.parseBody()
    const file = body['audio']
    if (!(file instanceof File)) return c.json({ error: 'no audio' }, 400)
    const buf = Buffer.from(await file.arrayBuffer())
    const text = await d.stt.transcribe(buf, file.type)
    return c.json({ text })
  })

  app.get('/audio/:file', (c) => {
    const name = path.basename(c.req.param('file'))
    const p = path.join(AUDIO_DIR, name)
    if (!fs.existsSync(p)) return c.notFound()
    const mime = name.endsWith('.mp3') ? 'audio/mpeg' : name.endsWith('.m4a') ? 'audio/mp4' : 'application/octet-stream'
    return c.body(fs.readFileSync(p), 200, { 'content-type': mime, 'cache-control': 'public, max-age=31536000, immutable' })
  })

  // ----- people -----
  app.get('/api/people', (c) => {
    const q = c.req.query('q')
    return c.json(q ? People.search(q) : People.all())
  })

  app.post('/api/people', async (c) => {
    const body = (await c.req.json()) as Partial<import('../shared/types.js').Person>
    if (!body.name || !body.name.trim()) return c.json({ error: 'name required' }, 400)
    return c.json(People.create({ ...body, name: body.name.trim() }))
  })

  app.get('/api/people/:id', (c) => {
    const p = People.get(c.req.param('id'))
    if (!p) return c.json({ error: 'not found' }, 404)
    const detail: PersonDetail = {
      person: p,
      facts: Facts.forPerson(p.id),
      commitments: Commitments.forPerson(p.id),
      events: Events.forPerson(p.id, addDays(new Date(), -30), addDays(new Date(), 30)),
      observations: Observations.forPerson(p.id),
    }
    return c.json(detail)
  })

  app.patch('/api/people/:id', async (c) => {
    const p = People.get(c.req.param('id'))
    if (!p) return c.json({ error: 'not found' }, 404)
    const body = (await c.req.json()) as Partial<import('../shared/types.js').Person>
    delete body.id
    return c.json(People.update(p.id, body))
  })

  app.delete('/api/people/:id', (c) => {
    People.remove(c.req.param('id'))
    return c.json({ ok: true })
  })

  app.post('/api/people/:id/facts', async (c) => {
    const p = People.get(c.req.param('id'))
    if (!p) return c.json({ error: 'not found' }, 404)
    const body = (await c.req.json()) as { text?: string }
    if (!body.text?.trim()) return c.json({ error: 'text required' }, 400)
    return c.json(Facts.add({ person_id: p.id, text: body.text, source: 'you', confidence: 0.95 }))
  })

  app.delete('/api/facts/:id', (c) => {
    Facts.retire(c.req.param('id'))
    return c.json({ ok: true })
  })

  // ----- commitments -----
  app.post('/api/commitments', async (c) => {
    const body = (await c.req.json()) as { text?: string; owner?: 'me' | 'them'; person_id?: string | null; due?: string | null }
    if (!body.text?.trim()) return c.json({ error: 'text required' }, 400)
    return c.json(Commitments.add({ text: body.text, owner: body.owner === 'them' ? 'them' : 'me', person_id: body.person_id ?? null, due: body.due ?? null }))
  })
  app.post('/api/commitments/:id/close', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { status?: 'done' | 'dropped' }
    Commitments.close(c.req.param('id'), body.status === 'dropped' ? 'dropped' : 'done')
    return c.json({ ok: true })
  })
  app.post('/api/commitments/:id/reopen', (c) => {
    Commitments.reopen(c.req.param('id'))
    return c.json({ ok: true })
  })

  // ----- memory -----
  app.get('/api/memory', (c) => {
    const dto: MemoryDTO = {
      profile: readProfile(),
      observations: Observations.recent(60),
      commitments: Commitments.recent(60),
      notes: Notes.recent('self', 20),
      facts: Facts.recent(60),
      people: People.all(),
      usageToday: usageToday(d),
    }
    return c.json(dto)
  })

  app.put('/api/memory/profile', async (c) => {
    const body = (await c.req.json()) as { text?: string }
    writeProfile(body.text ?? '')
    return c.json({ ok: true })
  })

  app.get('/api/tasks', (c) => c.json(Tasks.recent(50)))

  // ----- settings -----
  const settings = (): SettingsDTO => ({
    config: d.cfg(),
    providers: providers(d),
    keys: { anthropic: !!env.anthropicKey, elevenlabs: !!env.elevenKey, openai: !!env.openaiKey },
    envIcsFeeds: env.icsUrls.length,
    paths: { data: DATA_DIR, profile: PROFILE_PATH, localCalendar: LOCAL_CALENDAR_PATH },
  })

  app.get('/api/settings', (c) => c.json(settings()))

  app.patch('/api/settings', async (c) => {
    const patch = (await c.req.json()) as Record<string, unknown>
    delete patch['server']
    saveConfig(patch)
    d.scheduler.ensureDailyCheckins()
    d.scheduler.ensurePrepCheckins()
    return c.json(settings())
  })

  app.get('/api/settings/voices', async (c) => {
    try {
      return c.json({ provider: d.tts.provider, voices: await d.tts.voices() })
    } catch (err) {
      return c.json({ provider: d.tts.provider, voices: [], error: (err as Error).message })
    }
  })

  app.post('/api/settings/test-voice', async (c) => {
    const cfg = d.cfg()
    const body = (await c.req.json().catch(() => ({}))) as { text?: string }
    const text = body.text?.trim() || `${cfg.user.name}, it's ${cfg.assistant.name}. This is what I sound like. Your two o'clock moved to three, and I'd take the hour.`
    const s = await d.tts.synthesize(text)
    return c.json({ url: s.url, provider: d.tts.provider })
  })

  // ----- console -----
  const dist = path.join(process.cwd(), 'web', 'dist')
  app.use('/assets/*', serveStatic({ root: './web/dist' }))
  app.get('/', (c) => {
    const index = path.join(dist, 'index.html')
    if (fs.existsSync(index)) return c.html(fs.readFileSync(index, 'utf8'))
    return c.html(
      `<!doctype html><meta charset="utf-8"><title>Wren</title><body style="font-family:system-ui;padding:3rem;max-width:40rem"><h1 style="font-weight:600">Wren is running.</h1><p>The console has not been built yet. Run <code>npm run build</code> and reload, or use the dev server at <a href="http://localhost:5173">localhost:5173</a>.</p></body>`,
    )
  })
  app.use('/*', serveStatic({ root: './web/dist' }))

  return app
}
