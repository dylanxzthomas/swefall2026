// Shared DTOs between the server and the console. No secrets ever pass through these.

export type CheckinKind = 'morning' | 'midday' | 'evening' | 'prep' | 'adhoc' | 'onboarding'
export type CheckinStatus = 'scheduled' | 'prepared' | 'live' | 'done' | 'skipped' | 'missed'

export interface Attendee {
  name: string
  email: string | null
  person_id?: string | null
}

export interface Person {
  id: string
  name: string
  aliases: string[]
  emails: string[]
  relationship: string | null
  role: string | null
  company: string | null
  summary: string | null
  wants: string | null
  avoid: string | null
  notes: string | null
  last_contact_at: string | null
  created_at: string
  updated_at: string
}

export interface Fact {
  id: string
  person_id: string | null
  text: string
  source: string
  evidence: string | null
  confidence: number
  created_at: string
  retired_at: string | null
}

export interface CalEvent {
  id: string
  source: 'ics' | 'local'
  uid: string
  title: string
  description: string | null
  location: string | null
  start: string
  end: string
  all_day: number
  attendees: Attendee[]
  updated_at: string
}

export interface ScriptPoint {
  text: string
  evidence: string
}

export interface Script {
  opener: string
  points: ScriptPoint[]
  people: { name: string; brief: string }[]
  questions: string[]
  quiet: boolean
  observation_ids: string[]
}

export interface Checkin {
  id: string
  kind: CheckinKind
  event_id: string | null
  title: string
  scheduled_for: string
  status: CheckinStatus
  script: Script | null
  audio_path: string | null
  summary: string | null
  reason: string | null
  created_at: string
  started_at: string | null
  ended_at: string | null
}

export interface Message {
  id: string
  checkin_id: string
  role: 'user' | 'assistant'
  text: string
  audio_path: string | null
  meta: Record<string, unknown>
  created_at: string
}

export type ObservationKind = 'pattern' | 'risk' | 'opportunity' | 'social' | 'prediction' | 'followup'
export type SurfaceWhen = 'next_checkin' | 'before_event' | 'now' | 'never'

export interface Observation {
  id: string
  kind: ObservationKind
  text: string
  evidence: string[]
  confidence: number
  surface_when: SurfaceWhen
  event_id: string | null
  person_id: string | null
  status: 'queued' | 'surfaced' | 'dismissed' | 'expired'
  outcome: string | null
  created_at: string
  surfaced_at: string | null
  expires_at: string | null
}

export interface Commitment {
  id: string
  text: string
  owner: 'me' | 'them'
  person_id: string | null
  due: string | null
  status: 'open' | 'done' | 'dropped'
  source_checkin_id: string | null
  created_at: string
  closed_at: string | null
}

export interface TaskStep {
  tool: string
  summary: string
  at: string
}

export interface Task {
  id: string
  checkin_id: string | null
  request: string
  status: 'running' | 'done' | 'failed'
  steps: TaskStep[]
  result: string | null
  created_at: string
  finished_at: string | null
}

export interface Note {
  id: string
  kind: 'self' | 'user'
  text: string
  created_at: string
}

export interface Providers {
  brain: 'claude' | 'mock'
  model: string
  tts: 'elevenlabs' | 'openai' | 'mac'
  stt: 'elevenlabs' | 'openai' | 'browser'
  calendarFeeds: number
}

export interface Status {
  headline: string
  detail: string
  preparing: string | null
  reflecting: boolean
  lastReflectAt: string | null
  lastCalendarAt: string | null
  calendarErrors: string[]
  queued: number
}

export interface UsageToday {
  costUsd: number
  calls: number
  budgetUsd: number
}

export interface StateDTO {
  assistant: { name: string }
  user: { name: string }
  providers: Providers
  status: Status
  live: Checkin | null
  messages: Message[]
  tasks: Task[]
  today: { checkins: Checkin[]; events: CalEvent[] }
  tomorrow: { checkins: Checkin[]; events: CalEvent[] }
  surfaced: Observation[]
  usageToday: UsageToday
  now: string
}

export interface PersonDetail {
  person: Person
  facts: Fact[]
  commitments: Commitment[]
  events: CalEvent[]
  observations: Observation[]
}

export interface MemoryDTO {
  profile: string
  observations: Observation[]
  commitments: Commitment[]
  notes: Note[]
  facts: Fact[]
  people: Person[]
  usageToday: UsageToday
}

export interface AppConfig {
  assistant: {
    name: string
    model: string
    voice: { elevenlabsVoiceId: string; elevenlabsModel: string; openaiVoice: string; macVoice: string }
  }
  user: { name: string; emails: string[]; timezone: string }
  checkins: {
    morning: { time: string; days: string[]; enabled: boolean }
    midday: { time: string; days: string[]; enabled: boolean }
    evening: { time: string; days: string[]; enabled: boolean }
    prepMinutesBefore: number
    prepOnlyWithAttendees: boolean
  }
  quietHours: { start: string; end: string }
  thinking: { intervalMinutes: number; dailyBudgetUsd: number; webResearch: boolean; maxRequestedConversationsPerDay: number }
  notifications: { macos: boolean; speakAloud: boolean }
  calendar: { icsUrls: string[]; refreshMinutes: number }
  server: { port: number }
}

export interface SettingsDTO {
  config: AppConfig
  providers: Providers
  keys: { anthropic: boolean; elevenlabs: boolean; openai: boolean }
  envIcsFeeds: number
  paths: { data: string; profile: string; localCalendar: string }
}
