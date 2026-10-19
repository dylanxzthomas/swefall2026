import { voiceLimits, type VoiceEvent } from './voice.js'

export type VoiceCaption = { id: string; speaker: 'you' | 'sola'; text: string; final: boolean; at: number }
export type VoiceActivity = 'listening' | 'hearing' | 'thinking' | 'speaking' | 'working' | 'muted'
export const callCaptionLimits = { rows: 40, characters: 12000, items: 500, eventIds: 5000 } as const

/** Temporary in-memory captions only. Stable item IDs join partial and final text. */
export function voiceTranscript() {
  let rows: VoiceCaption[] = []
  const seen = new Set<string>(), retired = new Set<string>(), items = new Set<string>()
  return {
    update(event: Extract<VoiceEvent, { kind: 'transcript' }>, at = Date.now()): VoiceCaption[] | null {
      const id = event.id ?? `legacy:${event.speaker}:${event.text}`
      if (retired.has(id) || (event.eventId && seen.has(event.eventId))) return null
      // Stop accepting new caption identities at the bounded session limit.
      if ((!items.has(id) && items.size >= callCaptionLimits.items) || seen.size >= callCaptionLimits.eventIds) return null
      if (event.eventId) seen.add(event.eventId)
      items.add(id)
      const prior = rows.find(row => row.id === id)
      if (prior?.final) return null
      const final = event.final !== false
      const text = (final ? event.text : (prior?.text ?? '') + event.text).slice(0, voiceLimits.transcriptCharacters)
      const next: VoiceCaption = { id, speaker: event.speaker, text, final, at: prior?.at ?? at }
      rows = prior ? rows.map(row => row.id === id ? next : row) : [...rows, next]
      while (rows.length > callCaptionLimits.rows || rows.reduce((length, row) => length + row.text.length, 0) > callCaptionLimits.characters) {
        const removed = rows.shift()
        if (removed) retired.add(removed.id)
      }
      return rows.map(row => ({ ...row }))
    },
  }
}

export function voiceActivity({ input, playback, audioPlaying, responding, working, muted }: { input: boolean; playback: boolean; audioPlaying: boolean; responding: boolean; working: number; muted: boolean }): VoiceActivity {
  if (playback && audioPlaying) return 'speaking'
  if (input && !muted) return 'hearing'
  if (working > 0) return 'working'
  if (responding) return 'thinking'
  return muted ? 'muted' : 'listening'
}
