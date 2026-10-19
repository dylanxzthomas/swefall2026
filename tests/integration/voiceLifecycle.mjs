export class VoiceDeadline extends Error {
  constructor(category) { super(category); this.category = category }
}

/** Every fixture transport/teardown await must yield to a local deadline. */
export function within(work, milliseconds, category = 'fixture_deadline') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new VoiceDeadline(category)), milliseconds)
    Promise.resolve().then(work).then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}

/** Also used in a separate process so a stalled browser cannot defeat the cap. */
export function armVoiceWatchdog({ afterMs, stop, killBrowser, report = () => {}, stopMs = 3000, teardownMs = 5000 }) {
  let disposed = false
  const stopTimer = setTimeout(() => {
    void within(stop, stopMs, 'watchdog_stop_timeout').then(() => report('stopped'), () => report('stop_failed'))
  }, Math.max(0, afterMs))
  const killTimer = setTimeout(() => { if (!disposed) { killBrowser(); report('browser_killed') } }, Math.max(0, afterMs) + teardownMs)
  return { dispose() { disposed = true; clearTimeout(stopTimer); clearTimeout(killTimer) } }
}

export async function closeBounded(close, force, milliseconds = 2000) {
  try { await within(close, milliseconds, 'browser_close_timeout'); return true }
  catch { force(); return false }
}
