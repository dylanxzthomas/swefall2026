import { useEffect, useState } from 'react'
import { Check, SpeakerHigh } from '@phosphor-icons/react'
import type { AppConfig, SettingsDTO } from '../../../shared/types'
import { api } from '../api'
import { useStore } from '../store'
import { Button, Field, SectionTitle, Toggle, inputCls, textareaCls } from '../components/ui'

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

function DayPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="flex gap-1">
      {DAYS.map((d) => {
        const on = value.includes(d)
        return (
          <button key={d} type="button" onClick={() => onChange(on ? value.filter((x) => x !== d) : [...value, d])} className={`h-7 w-9 rounded-full text-[12px] font-medium capitalize ${on ? 'bg-accent text-accent-ink' : 'border border-line text-ink-3 hover:text-ink'}`}>
            {d.slice(0, 2)}
          </button>
        )
      })}
    </div>
  )
}

function CheckinRow({ label, spec, onChange }: { label: string; spec: AppConfig['checkins']['morning']; onChange: (s: AppConfig['checkins']['morning']) => void }) {
  return (
    <div className="flex flex-col gap-3 border-b border-line py-4 last:border-0 sm:flex-row sm:items-center sm:gap-6">
      <div className="w-40">
        <Toggle checked={spec.enabled} onChange={(v) => onChange({ ...spec, enabled: v })} label={label} />
      </div>
      <input type="time" value={spec.time} onChange={(e) => onChange({ ...spec, time: e.target.value })} className={`${inputCls} w-32 font-mono`} disabled={!spec.enabled} />
      <DayPicker value={spec.days} onChange={(days) => onChange({ ...spec, days })} />
    </div>
  )
}

export function Settings() {
  const { play, refresh } = useStore()
  const [s, setS] = useState<SettingsDTO | null>(null)
  const [cfg, setCfg] = useState<AppConfig | null>(null)
  const [voices, setVoices] = useState<{ id: string; name: string; note?: string }[]>([])
  const [voiceErr, setVoiceErr] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [ics, setIcs] = useState('')

  useEffect(() => {
    api.settings().then((d) => {
      setS(d)
      setCfg(d.config)
      setIcs(d.config.calendar.icsUrls.join('\n'))
    })
    api.voices().then((v) => {
      setVoices(v.voices)
      if (v.error) setVoiceErr(v.error)
    })
  }, [])

  if (!s || !cfg) return <div className="p-10 text-ink-3">Loading.</div>
  const set = (patch: Partial<AppConfig>) => setCfg({ ...cfg, ...patch })
  const voiceKey = s.providers.tts === 'elevenlabs' ? 'elevenlabsVoiceId' : s.providers.tts === 'openai' ? 'openaiVoice' : 'macVoice'

  const save = async () => {
    const next = { ...cfg, calendar: { ...cfg.calendar, icsUrls: ics.split('\n').map((x) => x.trim()).filter(Boolean) } }
    const d = await api.saveSettings(next)
    setS(d)
    setCfg(d.config)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
    await refresh()
  }

  return (
    <div className="mx-auto max-w-[760px] px-6 py-8 lg:px-10 lg:py-12">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-medium leading-tight tracking-tight text-ink">Settings</h1>
          <p className="mt-2 text-[14.5px] text-ink-2">Keys live in .env, never here. Everything else is saved to {s.paths.data}/wren.config.json.</p>
        </div>
        <Button variant="primary" onClick={() => void save()}>
          {saved ? <Check size={16} /> : null} {saved ? 'Saved' : 'Save'}
        </Button>
      </div>

      <section className="mt-10">
        <SectionTitle>Names</SectionTitle>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Your name">
            <input value={cfg.user.name} onChange={(e) => set({ user: { ...cfg.user, name: e.target.value } })} className={inputCls} />
          </Field>
          <Field label="Assistant's name">
            <input value={cfg.assistant.name} onChange={(e) => set({ assistant: { ...cfg.assistant, name: e.target.value } })} className={inputCls} />
          </Field>
          <Field label="Your email addresses" hint="Comma-separated. Used to leave you out of attendee lists.">
            <input value={cfg.user.emails.join(', ')} onChange={(e) => set({ user: { ...cfg.user, emails: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) } })} className={inputCls} />
          </Field>
          <Field label="Time zone">
            <input value={cfg.user.timezone} onChange={(e) => set({ user: { ...cfg.user, timezone: e.target.value } })} className={`${inputCls} font-mono text-[13px]`} />
          </Field>
        </div>
      </section>

      <section className="mt-10">
        <SectionTitle>When you talk</SectionTitle>
        <CheckinRow label="Morning check-in" spec={cfg.checkins.morning} onChange={(v) => set({ checkins: { ...cfg.checkins, morning: v } })} />
        <CheckinRow label="Midday check" spec={cfg.checkins.midday} onChange={(v) => set({ checkins: { ...cfg.checkins, midday: v } })} />
        <CheckinRow label="Evening debrief" spec={cfg.checkins.evening} onChange={(v) => set({ checkins: { ...cfg.checkins, evening: v } })} />
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Brief me before a meeting" hint="Minutes before it starts.">
            <input type="number" min={2} max={120} value={cfg.checkins.prepMinutesBefore} onChange={(e) => set({ checkins: { ...cfg.checkins, prepMinutesBefore: Number(e.target.value) } })} className={`${inputCls} w-28 font-mono`} />
          </Field>
          <div className="flex items-end pb-1">
            <Toggle checked={cfg.checkins.prepOnlyWithAttendees} onChange={(v) => set({ checkins: { ...cfg.checkins, prepOnlyWithAttendees: v } })} label="Only meetings with other people" />
          </div>
          <Field label="Quiet from">
            <input type="time" value={cfg.quietHours.start} onChange={(e) => set({ quietHours: { ...cfg.quietHours, start: e.target.value } })} className={`${inputCls} w-32 font-mono`} />
          </Field>
          <Field label="Quiet until">
            <input type="time" value={cfg.quietHours.end} onChange={(e) => set({ quietHours: { ...cfg.quietHours, end: e.target.value } })} className={`${inputCls} w-32 font-mono`} />
          </Field>
        </div>
      </section>

      <section className="mt-10">
        <SectionTitle>Thinking while you are away</SectionTitle>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Look at the next two days every" hint="Minutes. Only runs when something changed.">
            <input type="number" min={5} max={240} value={cfg.thinking.intervalMinutes} onChange={(e) => set({ thinking: { ...cfg.thinking, intervalMinutes: Number(e.target.value) } })} className={`${inputCls} w-28 font-mono`} />
          </Field>
          <Field label="Daily budget, USD" hint="Live conversations may run to twice this so they never die mid-sentence.">
            <input type="number" min={0.5} step={0.5} value={cfg.thinking.dailyBudgetUsd} onChange={(e) => set({ thinking: { ...cfg.thinking, dailyBudgetUsd: Number(e.target.value) } })} className={`${inputCls} w-28 font-mono`} />
          </Field>
          <Field label="Model" hint="An Anthropic model id.">
            <input value={cfg.assistant.model} onChange={(e) => set({ assistant: { ...cfg.assistant, model: e.target.value } })} className={`${inputCls} font-mono text-[13px]`} />
          </Field>
          <Field label="Unprompted conversations per day" hint="How often it may ask for a word on its own.">
            <input type="number" min={0} max={10} value={cfg.thinking.maxRequestedConversationsPerDay} onChange={(e) => set({ thinking: { ...cfg.thinking, maxRequestedConversationsPerDay: Number(e.target.value) } })} className={`${inputCls} w-28 font-mono`} />
          </Field>
          <div className="sm:col-span-2">
            <Toggle checked={cfg.thinking.webResearch} onChange={(v) => set({ thinking: { ...cfg.thinking, webResearch: v } })} label="Let it search the web about people and companies before meetings" />
          </div>
        </div>
      </section>

      <section className="mt-10">
        <SectionTitle>How it reaches you</SectionTitle>
        <div className="flex flex-col gap-3">
          <Toggle checked={cfg.notifications.macos} onChange={(v) => set({ notifications: { ...cfg.notifications, macos: v } })} label="Mac notifications when a conversation starts" />
          <Toggle checked={cfg.notifications.speakAloud} onChange={(v) => set({ notifications: { ...cfg.notifications, speakAloud: v } })} label="Speak through the Mac's speakers when this console is closed" />
        </div>
      </section>

      <section className="mt-10">
        <SectionTitle>Voice</SectionTitle>
        <p className="text-[14px] text-ink-2">
          Speaking with {s.providers.tts === 'elevenlabs' ? 'ElevenLabs' : s.providers.tts === 'openai' ? 'OpenAI' : "the Mac's built-in voice"}. Hearing with {s.providers.stt === 'browser' ? 'the browser' : s.providers.stt === 'elevenlabs' ? 'ElevenLabs Scribe' : 'OpenAI'}.
          {s.providers.tts === 'mac' && ' Add ELEVENLABS_API_KEY or OPENAI_API_KEY to .env for a better one.'}
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field label="Voice">
            {voices.length ? (
              <select value={cfg.assistant.voice[voiceKey]} onChange={(e) => set({ assistant: { ...cfg.assistant, voice: { ...cfg.assistant.voice, [voiceKey]: e.target.value } } })} className={inputCls}>
                {!voices.some((v) => v.id === cfg.assistant.voice[voiceKey]) && <option value={cfg.assistant.voice[voiceKey]}>{cfg.assistant.voice[voiceKey]}</option>}
                {voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                    {v.note ? ` (${v.note})` : ''}
                  </option>
                ))}
              </select>
            ) : (
              <input value={cfg.assistant.voice[voiceKey]} onChange={(e) => set({ assistant: { ...cfg.assistant, voice: { ...cfg.assistant.voice, [voiceKey]: e.target.value } } })} className={`${inputCls} font-mono text-[13px]`} />
            )}
          </Field>
          <Button
            onClick={async () => {
              setTesting(true)
              try {
                await save()
                const r = await api.testVoice()
                await play(r.url)
              } finally {
                setTesting(false)
              }
            }}
            disabled={testing}
          >
            <SpeakerHigh size={16} /> {testing ? 'Rendering' : 'Hear it'}
          </Button>
          {s.providers.tts === 'elevenlabs' && (
            <Field label="ElevenLabs model" hint="eleven_v3 is the expressive one; it falls back to eleven_multilingual_v2 if unavailable.">
              <input value={cfg.assistant.voice.elevenlabsModel} onChange={(e) => set({ assistant: { ...cfg.assistant, voice: { ...cfg.assistant.voice, elevenlabsModel: e.target.value } } })} className={`${inputCls} font-mono text-[13px]`} />
            </Field>
          )}
        </div>
        {voiceErr && <p className="mt-2 text-[13px] text-danger">{voiceErr}</p>}
      </section>

      <section className="mt-10">
        <SectionTitle>Calendar</SectionTitle>
        <p className="text-[14px] text-ink-2">
          {s.envIcsFeeds > 0 ? `${s.envIcsFeeds} feed${s.envIcsFeeds === 1 ? '' : 's'} from .env.` : 'No feeds in .env.'} Add more below, one ICS URL per line. Google Calendar: Settings, your calendar, "Secret address in iCal format".
        </p>
        <textarea value={ics} onChange={(e) => setIcs(e.target.value)} rows={3} className={`${textareaCls} mt-3 font-mono text-[12.5px]`} placeholder="https://calendar.google.com/calendar/ical/.../basic.ics" spellCheck={false} />
        <p className="mt-2 text-[12.5px] text-ink-3">Events it creates for you go to {s.paths.localCalendar}.</p>
      </section>

      <section className="mt-10">
        <SectionTitle>Keys</SectionTitle>
        <ul className="flex flex-col gap-1.5 text-[14px]">
          {[
            ['ANTHROPIC_API_KEY', s.keys.anthropic, 'the brain'],
            ['ELEVENLABS_API_KEY', s.keys.elevenlabs, 'voice in and out'],
            ['OPENAI_API_KEY', s.keys.openai, 'voice, if no ElevenLabs'],
          ].map(([k, on, what]) => (
            <li key={String(k)} className="flex items-center gap-3">
              <span className={`h-2 w-2 rounded-full ${on ? 'bg-accent' : 'bg-line-2'}`} />
              <span className="font-mono text-[13px] text-ink">{k}</span>
              <span className="text-ink-3">
                {on ? 'set' : 'not set'} · {what}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[12.5px] text-ink-3">Edit .env in the project folder, then restart.</p>
      </section>
    </div>
  )
}
