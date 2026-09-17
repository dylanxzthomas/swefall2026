import { execFile } from 'node:child_process'
import { getConfig } from './config.js'

const q = (s: string) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'

/** A macOS notification. Silent no-op elsewhere or when turned off. */
export function notify(title: string, body: string, subtitle?: string): void {
  if (process.platform !== 'darwin' || !getConfig().notifications.macos) return
  const script = `display notification ${q(body.slice(0, 200))} with title ${q(title)}${subtitle ? ` subtitle ${q(subtitle)}` : ''} sound name "Glass"`
  execFile('osascript', ['-e', script], (err) => {
    if (err) console.warn(`[notify] ${err.message}`)
  })
}

let current: ReturnType<typeof execFile> | null = null

/** Speak through the Mac's speakers (used when the console is not open to play it). */
export function playAloud(path: string): void {
  if (process.platform !== 'darwin') return
  if (current) current.kill()
  current = execFile('afplay', [path], () => {
    current = null
  })
}
