import { serve } from '@hono/node-server'
import { DATA_DIR, PROFILE, ROOT, env, getConfig, icsUrls, loadConfig } from './config.js'
import { Brain } from './llm.js'
import { TTS } from './voice/tts.js'
import { STT } from './voice/stt.js'
import { Scheduler } from './scheduler.js'
import { createApp } from './http.js'

process.chdir(ROOT)
const cfg = loadConfig()
const brain = new Brain(getConfig)
const tts = new TTS(getConfig)
const stt = new STT()
const scheduler = new Scheduler(getConfig, brain, tts)
const app = createApp({ cfg: getConfig, brain, tts, stt, scheduler })

const server = serve({ fetch: app.fetch, port: cfg.server.port, hostname: '127.0.0.1' }, (info) => {
  const voice = tts.provider === 'elevenlabs' ? `ElevenLabs ${cfg.assistant.voice.elevenlabsModel}` : tts.provider === 'openai' ? `OpenAI ${cfg.assistant.voice.openaiVoice}` : `Mac voice ${cfg.assistant.voice.macVoice}`
  console.log(`
${cfg.assistant.name} is up.        http://localhost:${info.port}
Profile: ${PROFILE}            Data: ${DATA_DIR}
Brain:   ${brain.available ? cfg.assistant.model : `mock (${env.mockBrain ? 'WREN_MOCK_BRAIN=1' : 'no ANTHROPIC_API_KEY'})`}
Voice:   ${voice}      Hearing: ${stt.provider}
Calendar feeds: ${icsUrls(cfg).length}      Budget: $${cfg.thinking.dailyBudgetUsd}/day
`)
  // Household planning is on demand. Keep the original meeting daemon opt-in.
  if (process.env.WREN_LEGACY === '1') scheduler.start()
})

const shutdown = () => {
  scheduler.stop()
  server.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
