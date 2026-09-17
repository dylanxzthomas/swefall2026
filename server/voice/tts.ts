import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import type { Config } from '../config.js'
import { AUDIO_DIR, env } from '../config.js'

export type TTSProvider = 'elevenlabs' | 'openai' | 'mac'

export interface Synth {
  path: string
  url: string
  mime: string
}

const run = (cmd: string, args: string[]) =>
  new Promise<void>((resolve, reject) => execFile(cmd, args, { maxBuffer: 1 << 20 }, (err, _out, stderr) => (err ? reject(new Error(`${cmd}: ${stderr || err.message}`)) : resolve())))

/** Text to speech. ElevenLabs when a key is present (the expressive v3 model, with a fallback), then OpenAI, then the Mac's own voice so it always works. */
export class TTS {
  constructor(private readonly cfg: () => Config) {}

  get provider(): TTSProvider {
    if (env.elevenKey) return 'elevenlabs'
    if (env.openaiKey) return 'openai'
    return 'mac'
  }

  async synthesize(text: string): Promise<Synth> {
    const clean = text.replace(/\s+/g, ' ').trim()
    if (!clean) throw new Error('nothing to say')
    const v = this.cfg().assistant.voice
    const provider = this.provider
    const voiceKey = provider === 'elevenlabs' ? `${v.elevenlabsVoiceId}:${v.elevenlabsModel}` : provider === 'openai' ? v.openaiVoice : v.macVoice
    const hash = crypto.createHash('sha1').update(`${provider}|${voiceKey}|${clean}`).digest('hex').slice(0, 24)
    const ext = provider === 'mac' ? 'm4a' : 'mp3'
    const file = path.join(AUDIO_DIR, `${hash}.${ext}`)
    const mime = ext === 'mp3' ? 'audio/mpeg' : 'audio/mp4'
    if (fs.existsSync(file)) return { path: file, url: `/audio/${path.basename(file)}`, mime }
    if (provider === 'elevenlabs') await this.elevenlabs(clean, file)
    else if (provider === 'openai') await this.openai(clean, file)
    else await this.mac(clean, file)
    return { path: file, url: `/audio/${path.basename(file)}`, mime }
  }

  private async elevenlabs(text: string, file: string): Promise<void> {
    const v = this.cfg().assistant.voice
    const attempt = async (model: string) => {
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(v.elevenlabsVoiceId)}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'xi-api-key': env.elevenKey, 'content-type': 'application/json' },
        body: JSON.stringify({ text, model_id: model }),
      })
      if (!r.ok) throw new Error(`ElevenLabs ${r.status} (${model}): ${(await r.text()).slice(0, 200)}`)
      fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()))
    }
    try {
      await attempt(v.elevenlabsModel)
    } catch (err) {
      if (v.elevenlabsModel === 'eleven_multilingual_v2') throw err
      console.warn(`[tts] ${(err as Error).message}; retrying with eleven_multilingual_v2`)
      await attempt('eleven_multilingual_v2')
    }
  }

  private async openai(text: string, file: string): Promise<void> {
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.openaiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: this.cfg().assistant.voice.openaiVoice, input: text, response_format: 'mp3' }),
    })
    if (!r.ok) throw new Error(`OpenAI TTS ${r.status}: ${(await r.text()).slice(0, 200)}`)
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()))
  }

  private async mac(text: string, file: string): Promise<void> {
    if (process.platform !== 'darwin') throw new Error('no voice provider configured and this is not a Mac')
    const tmp = path.join(os.tmpdir(), `wren-${crypto.randomUUID()}`)
    const txt = `${tmp}.txt`
    const aiff = `${tmp}.aiff`
    fs.writeFileSync(txt, text)
    try {
      await run('say', ['-v', this.cfg().assistant.voice.macVoice, '-f', txt, '-o', aiff])
      await run('afconvert', ['-f', 'm4af', '-d', 'aac', aiff, file])
    } finally {
      for (const f of [txt, aiff]) if (fs.existsSync(f)) fs.unlinkSync(f)
    }
  }

  /** Voices the current provider can use, for the settings screen. */
  async voices(): Promise<{ id: string; name: string; note?: string }[]> {
    if (this.provider === 'elevenlabs') {
      const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': env.elevenKey } })
      if (!r.ok) throw new Error(`ElevenLabs ${r.status}`)
      const j = (await r.json()) as { voices: { voice_id: string; name: string; labels?: Record<string, string> }[] }
      return j.voices.map((v) => ({ id: v.voice_id, name: v.name, note: Object.values(v.labels ?? {}).slice(0, 3).join(', ') }))
    }
    if (this.provider === 'openai') return ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'].map((n) => ({ id: n, name: n }))
    return new Promise((resolve) =>
      execFile('say', ['-v', '?'], (err, out) => {
        if (err) return resolve([{ id: 'Samantha', name: 'Samantha' }])
        const list = out
          .split('\n')
          .map((l) => l.match(/^(.+?)\s{2,}(en_[A-Z]{2})/))
          .filter((m): m is RegExpMatchArray => !!m)
          .map((m) => ({ id: m[1].trim(), name: m[1].trim(), note: m[2] }))
          .filter((v) => !/^(Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Wobble|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Zarvox|Junior|Ralph|Fred|Kathy|Albert|Grandma|Grandpa|Eddy|Reed|Rocko|Shelley|Sandy|Flo)/.test(v.id))
        resolve(list)
      }),
    )
  }
}
