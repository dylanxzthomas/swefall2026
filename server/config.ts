import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppConfig } from '../shared/types.js'

export type Config = AppConfig

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const PROFILE = process.env.WREN_PROFILE || 'default'
export const DATA_DIR = PROFILE === 'default' ? path.join(ROOT, 'data') : path.join(ROOT, 'data', PROFILE)
export const AUDIO_DIR = path.join(DATA_DIR, 'audio')
export const CONFIG_PATH = path.join(DATA_DIR, 'wren.config.json')
export const PROFILE_PATH = path.join(DATA_DIR, 'about-me.md')
export const LOCAL_CALENDAR_PATH = path.join(DATA_DIR, 'calendar.json')

for (const d of [DATA_DIR, AUDIO_DIR]) fs.mkdirSync(d, { recursive: true })

const envFile = path.join(ROOT, '.env')
if (fs.existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile)
  } catch {
    // a malformed .env should not stop the daemon; the keys just won't be there
  }
}

export const env = {
  get anthropicKey() {
    return process.env.ANTHROPIC_API_KEY || ''
  },
  get elevenKey() {
    return process.env.ELEVENLABS_API_KEY || process.env.ELEVEN_API_KEY || ''
  },
  get openaiKey() {
    return process.env.OPENAI_API_KEY || ''
  },
  get mockBrain() {
    return process.env.WREN_MOCK_BRAIN === '1'
  },
  get icsUrls(): string[] {
    return (process.env.WREN_ICS_URLS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  },
}

export const DEFAULT_CONFIG: Config = {
  assistant: {
    name: 'Wren',
    model: 'claude-opus-5',
    voice: {
      elevenlabsVoiceId: 'pFZP5JQG7iQjIQuC4Bp6',
      elevenlabsModel: 'eleven_v3',
      openaiVoice: 'nova',
      macVoice: 'Samantha',
    },
  },
  user: {
    name: 'Dylan',
    emails: [],
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  },
  checkins: {
    morning: { time: '08:30', days: ['mon', 'tue', 'wed', 'thu', 'fri'], enabled: true },
    midday: { time: '13:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'], enabled: false },
    evening: { time: '18:30', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], enabled: true },
    prepMinutesBefore: 15,
    prepOnlyWithAttendees: true,
  },
  quietHours: { start: '22:30', end: '07:30' },
  thinking: { intervalMinutes: 20, dailyBudgetUsd: 5, webResearch: false, maxRequestedConversationsPerDay: 2 },
  notifications: { macos: true, speakAloud: true },
  calendar: { icsUrls: [], refreshMinutes: 10 },
  server: { port: 4747 },
}

type Plain = Record<string, unknown>

function isPlain(v: unknown): v is Plain {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlain(base) || !isPlain(patch)) return (patch === undefined ? base : (patch as T))
  const out: Plain = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    out[k] = isPlain(v) && isPlain(out[k]) ? deepMerge(out[k], v) : v
  }
  return out as T
}

let current: Config | null = null

export function loadConfig(): Config {
  let fromFile: unknown = {}
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      fromFile = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    } catch (e) {
      console.warn(`[config] could not parse ${CONFIG_PATH}: ${(e as Error).message}. Using defaults.`)
    }
  }
  current = deepMerge(structuredClone(DEFAULT_CONFIG), fromFile)
  if (!fs.existsSync(CONFIG_PATH)) fs.writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2) + '\n')
  return current
}

export function getConfig(): Config {
  return current ?? loadConfig()
}

export function saveConfig(patch: unknown): Config {
  current = deepMerge(getConfig(), patch)
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2) + '\n')
  return current
}

/** All calendar feeds: config + env, de-duplicated. */
export function icsUrls(cfg: Config): string[] {
  return Array.from(new Set([...cfg.calendar.icsUrls, ...env.icsUrls]))
}
