import { readFileSync } from 'node:fs'
import { ConvexHttpClient } from 'convex/browser'
import { api } from '../../convex/_generated/api.js'
import { armVoiceWatchdog, within } from './voiceLifecycle.mjs'

// No stdout, provider calls, or credential IPC. This process independently stops
// only its randomly named synthetic owner and can kill only its browser group.
let guard, client, browserPid, armed = false
const notify = status => { if (process.connected) process.send({ status }) }
const killBrowser = () => {
  if (!Number.isInteger(browserPid) || browserPid <= 1 || browserPid === process.pid || browserPid === process.ppid) return
  try { process.kill(-browserPid, 'SIGKILL') } catch { try { process.kill(browserPid, 'SIGKILL') } catch {} }
}
const stop = async () => {
  if (!client) return
  const current = (await client.query(api.voice.settings, {})).active
  if (current) await client.mutation(api.voice.stop, { id: current.id, version: current.version })
}
process.on('message', message => {
  if (message?.type === 'disarm') { guard?.dispose(); process.exit(0) }
  if (armed || message?.type !== 'arm') return
  try {
    if (typeof message.owner !== 'string' || !/^https:\/\/daymark-test\.invalid\|synthetic-voice-[a-f0-9-]{36}$/.test(message.owner) || !Number.isFinite(message.deadlineAt) || message.deadlineAt > Date.now() + 21000 || message.deadlineAt < Date.now()) throw new Error('Invalid fixture watchdog.')
    const config = JSON.parse(readFileSync('.convex/local/default/config.json', 'utf8'))
    if (config.ports.cloud !== 3210) throw new Error('Invalid local fixture port.')
    client = new ConvexHttpClient('http://127.0.0.1:3210', { logger: false, fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(1500) }) })
    client.setAdminAuth(config.adminKey, { subject: message.owner.split('|').at(-1), tokenIdentifier: message.owner, issuer: 'https://daymark-test.invalid' })
    browserPid = message.browserPid; armed = true
    guard = armVoiceWatchdog({ afterMs: message.deadlineAt - Date.now(), stop, killBrowser, report: status => { notify(status); if (status === 'browser_killed') process.exit(0) } })
    notify('armed')
  } catch { notify('arm_failed'); process.exit(1) }
})
process.on('disconnect', () => {
  if (!armed) process.exit(0)
  guard?.dispose(); killBrowser(); void within(stop, 3000).then(() => process.exit(0), () => process.exit(0))
})
setTimeout(() => { guard?.dispose(); killBrowser(); process.exit(1) }, 45000)
