import { env } from '../config.js'

export type STTProvider = 'elevenlabs' | 'openai' | 'browser'

const extFor = (mime: string) => (mime.includes('webm') ? 'webm' : mime.includes('mp4') || mime.includes('m4a') ? 'm4a' : mime.includes('ogg') ? 'ogg' : mime.includes('wav') ? 'wav' : 'webm')

/** Speech to text. ElevenLabs Scribe, then OpenAI; with neither, the console uses the browser's own recognition. */
export class STT {
  get provider(): STTProvider {
    if (env.elevenKey) return 'elevenlabs'
    if (env.openaiKey) return 'openai'
    return 'browser'
  }

  async transcribe(audio: Buffer, mime: string): Promise<string> {
    const p = this.provider
    if (p === 'browser') throw new Error('no server-side speech recognition configured')
    const form = new FormData()
    const blob = new Blob([new Uint8Array(audio)], { type: mime || 'audio/webm' })
    if (p === 'elevenlabs') {
      form.append('model_id', 'scribe_v1')
      form.append('file', blob, `audio.${extFor(mime)}`)
      const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': env.elevenKey }, body: form })
      if (!r.ok) throw new Error(`ElevenLabs STT ${r.status}: ${(await r.text()).slice(0, 200)}`)
      const j = (await r.json()) as { text?: string }
      return (j.text ?? '').trim()
    }
    form.append('model', 'gpt-4o-mini-transcribe')
    form.append('file', blob, `audio.${extFor(mime)}`)
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { authorization: `Bearer ${env.openaiKey}` }, body: form })
    if (!r.ok) throw new Error(`OpenAI STT ${r.status}: ${(await r.text()).slice(0, 200)}`)
    const j = (await r.json()) as { text?: string }
    return (j.text ?? '').trim()
  }
}
