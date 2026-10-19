import { expect, it } from 'vitest'
import { voiceEvent, type VoiceEvent } from './voice.js'
import { callCaptionLimits, voiceActivity, voiceTranscript } from './voiceTranscript.js'

function event(type: string, text: string, item = 'item_1', eventId?: string) {
  return voiceEvent(JSON.stringify({ type, item_id: item, content_index: 0, ...(eventId ? { event_id: eventId } : {}), ...(type.endsWith('.delta') ? { delta: text } : { transcript: text }) })) as Extract<VoiceEvent, { kind: 'transcript' }>
}
const delta = 'conversation.item.input_audio_transcription.delta', done = 'conversation.item.input_audio_transcription.completed'

it('joins incremental input by item, preserves spaces, replaces final text, and ignores repeated/late events', () => {
  const captions = voiceTranscript()
  expect(captions.update(event(delta, 'Pick', 'item_1', 'e1'), 100)?.[0]).toMatchObject({ id: 'you:item_1:0', text: 'Pick', final: false, at: 100 })
  expect(captions.update(event(delta, 'Pick', 'item_1', 'e1'), 101)).toBeNull()
  expect(captions.update(event(delta, ' up Maya', 'item_1', 'e2'), 102)?.[0].text).toBe('Pick up Maya')
  expect(captions.update(event(done, 'Pick up Maya at three.', 'item_1', 'e3'), 103)?.[0]).toMatchObject({ text: 'Pick up Maya at three.', final: true, at: 100 })
  expect(captions.update(event(done, 'Pick up Maya at three.', 'item_1', 'e4'), 104)).toBeNull()
  expect(captions.update(event(delta, 'late fragment', 'item_1', 'e5'), 105)).toBeNull()
})

it('keeps overlapping user/assistant items and out-of-order finalization separate', () => {
  const captions = voiceTranscript()
  captions.update(event(delta, 'First', 'first'), 100)
  captions.update(event(delta, 'Second', 'second'), 200)
  captions.update(event('response.output_audio_transcript.delta', 'I can', 'reply'), 300)
  captions.update(event(done, 'Second question.', 'second'), 400)
  const rows = captions.update(event(done, 'First question.', 'first'), 500)!
  expect(rows.map(row => [row.text, row.at])).toEqual([['First question.', 100], ['Second question.', 200], ['I can', 300]])
  expect(captions.update(event('response.output_audio_transcript.done', 'I can prepare that.', 'reply'), 600)?.[2]).toMatchObject({ speaker: 'sola', final: true, at: 300 })
})

it('bounds temporary captions and never resurrects an evicted item on delayed delivery', () => {
  const captions = voiceTranscript()
  let rows
  for (let n = 0; n < 50; n++) rows = captions.update(event(done, `Synthetic caption ${n}`, `item_${n}`), n)
  expect(rows).toHaveLength(callCaptionLimits.rows)
  expect(rows?.[0].id).toBe('you:item_10:0')
  expect(captions.update(event(done, 'Delayed duplicate', 'item_0'))).toBeNull()
  for (let n = 50; n < 60; n++) rows = captions.update(event(done, 'a'.repeat(3000), `item_${n}`), n)
  expect(rows!.reduce((length, row) => length + row.text.length, 0)).toBeLessThanOrEqual(callCaptionLimits.characters)
})

it('requires a bounded stable identity for partial captions and validates indices', () => {
  for (const value of [
    { type: delta, delta: 'Partial without an item' },
    { type: delta, item_id: 'x'.repeat(201), delta: 'Too large identity' },
    { type: delta, item_id: 'item', content_index: -1, delta: 'Bad index' },
    { type: delta, item_id: 'item', content_index: '0', delta: 'Bad index' },
    { type: delta, item_id: 'item', content_index: 0, delta: { text: 'Not text' } },
  ]) expect(voiceEvent(JSON.stringify(value))).toBeNull()
  expect(voiceEvent(JSON.stringify({ type: delta, item_id: 'item', content_index: 1, delta: ' ' }))).toMatchObject({ id: 'you:item:1', text: ' ', final: false })
})

it('uses actual speech/buffer events, including interruption, without interpreting response completion as playback completion', () => {
  expect(voiceEvent(JSON.stringify({ type: 'input_audio_buffer.speech_started' }))).toEqual({ kind: 'input', active: true })
  expect(voiceEvent(JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }))).toEqual({ kind: 'input', active: false })
  expect(voiceEvent(JSON.stringify({ type: 'output_audio_buffer.started' }))).toEqual({ kind: 'playback', active: true })
  for (const type of ['output_audio_buffer.stopped', 'output_audio_buffer.cleared']) expect(voiceEvent(JSON.stringify({ type }))).toEqual({ kind: 'playback', active: false })
  const base = { input: false, playback: false, audioPlaying: false, responding: false, working: 0, muted: false }
  expect(voiceActivity(base)).toBe('listening')
  expect(voiceActivity({ ...base, playback: true })).toBe('listening')
  expect(voiceActivity({ ...base, playback: true, audioPlaying: true })).toBe('speaking')
  expect(voiceActivity({ ...base, input: true })).toBe('hearing')
  expect(voiceActivity({ ...base, responding: true })).toBe('thinking')
  expect(voiceActivity({ ...base, working: 1 })).toBe('working')
  expect(voiceActivity({ ...base, muted: true, input: true })).toBe('muted')
})
