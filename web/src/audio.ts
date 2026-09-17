type Listener = (speaking: boolean) => void

/** A silent WAV, used to unlock audio playback on the first click so later audio can start on its own. */
function silentWav(): string {
  const sampleRate = 8000
  const samples = 800
  const buf = new ArrayBuffer(44 + samples * 2)
  const v = new DataView(buf)
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i))
  }
  str(0, 'RIFF')
  v.setUint32(4, 36 + samples * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, samples * 2, true)
  let bin = ''
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return `data:audio/wav;base64,${btoa(bin)}`
}

class Player {
  private el = new Audio()
  private listeners = new Set<Listener>()
  unlocked = false

  constructor() {
    this.el.preload = 'auto'
    this.el.addEventListener('play', () => this.notify(true))
    this.el.addEventListener('ended', () => this.notify(false))
    this.el.addEventListener('pause', () => this.notify(false))
    this.el.addEventListener('error', () => this.notify(false))
  }

  private notify(v: boolean) {
    for (const l of this.listeners) l(v)
  }

  onChange(l: Listener): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  /** Call from inside a user gesture. */
  async unlock(): Promise<boolean> {
    if (this.unlocked) return true
    try {
      this.el.src = silentWav()
      await this.el.play()
      this.el.pause()
      this.unlocked = true
    } catch {
      this.unlocked = false
    }
    return this.unlocked
  }

  async play(url: string): Promise<void> {
    this.el.pause()
    this.el.src = url
    try {
      await this.el.play()
    } catch (err) {
      this.notify(false)
      throw err
    }
  }

  stop(): void {
    this.el.pause()
    this.el.currentTime = 0
  }
}

export const player = new Player()
