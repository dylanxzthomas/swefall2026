import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Message, StateDTO } from '../../shared/types'
import { api } from './api'
import { player } from './audio'

export type Route = { name: 'talk'; id?: string } | { name: 'schedule' } | { name: 'people'; id?: string } | { name: 'memory' } | { name: 'settings' }

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  switch (parts[0]) {
    case 'meeting':
      return { name: 'talk', id: parts[1] }
    case 'schedule':
      return { name: 'schedule' }
    case 'people':
      return { name: 'people', id: parts[1] }
    case 'memory':
      return { name: 'memory' }
    case 'settings':
      return { name: 'settings' }
    default:
      return { name: 'talk' }
  }
}

export interface Pending {
  text: string
  via: 'voice' | 'text'
}

interface Store {
  state: StateDTO | null
  error: string | null
  route: Route
  connected: boolean
  thinking: boolean
  speaking: boolean
  soundOn: boolean
  brainBusy: number
  pending: Pending | null
  refresh(): Promise<void>
  navigate(hash: string): void
  enableSound(): Promise<void>
  play(url: string | null): Promise<void>
  stopAudio(): void
  startCheckin(id: string): Promise<void>
  /** Say something. If nothing is live, a conversation opens on the spot. */
  say(text: string, via: 'voice' | 'text'): Promise<void>
  endCheckin(id: string): Promise<void>
  skipCheckin(id: string): Promise<void>
  thinkNow(): Promise<void>
}

const Ctx = createContext<Store | null>(null)

const audioUrlOf = (m: Message | null | undefined) => (m?.audio_path ? `/audio/${m.audio_path.split('/').pop()}` : null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StateDTO | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash))
  const [connected, setConnected] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [soundOn, setSoundOn] = useState(player.unlocked)
  const [brainBusy, setBrainBusy] = useState(0)
  const [pending, setPending] = useState<Pending | null>(null)
  const played = useRef(new Set<string>())
  const refreshTimer = useRef<number | null>(null)
  const stateRef = useRef<StateDTO | null>(null)
  stateRef.current = state

  const refresh = useCallback(async () => {
    try {
      const s = await api.state()
      setState(s)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [])

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) window.clearTimeout(refreshTimer.current)
    refreshTimer.current = window.setTimeout(() => void refresh(), 150)
  }, [refresh])

  const navigate = useCallback((hash: string) => {
    if (location.hash !== hash) location.hash = hash
    else setRoute(parseRoute(hash))
  }, [])

  const play = useCallback(async (url: string | null) => {
    if (!url || !player.unlocked) return
    try {
      await player.play(url)
    } catch {
      // autoplay refused; the transcript still shows the words
    }
  }, [])

  const enableSound = useCallback(async () => {
    const ok = await player.unlock()
    setSoundOn(ok)
    if (ok) localStorage.setItem('wren.sound', '1')
  }, [])

  // Any click counts as the gesture that lets audio play afterwards.
  useEffect(() => {
    if (player.unlocked) return
    const once = () => {
      void enableSound()
    }
    document.addEventListener('pointerdown', once, { once: true })
    return () => document.removeEventListener('pointerdown', once)
  }, [enableSound])

  useEffect(() => player.onChange(setSpeaking), [])

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    void refresh()
    const es = new EventSource('/api/events')
    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false)
    const on = (type: string, fn: (data: any) => void) => es.addEventListener(type, (e) => fn(JSON.parse((e as MessageEvent).data || '{}')))
    on('hello', () => {
      setConnected(true)
      scheduleRefresh()
    })
    on('checkin.live', (d: { checkin: { id: string }; message: Message | null }) => {
      scheduleRefresh()
      navigate('#/')
      const url = audioUrlOf(d.message)
      if (d.message && url && !played.current.has(d.message.id)) {
        played.current.add(d.message.id)
        void play(url)
      }
    })
    on('message', (d: { message: Message }) => {
      scheduleRefresh()
      if (d.message.role === 'assistant' && !played.current.has(d.message.id)) {
        played.current.add(d.message.id)
        void play(audioUrlOf(d.message))
      }
    })
    on('assistant.thinking', (d: { on: boolean }) => setThinking(!!d.on))
    on('brain.busy', (d: { inFlight: number }) => setBrainBusy(d.inFlight ?? 0))
    for (const t of ['checkin.scheduled', 'checkin.prepared', 'checkin.preparing', 'checkin.ended', 'status', 'reflected', 'calendar.refreshed', 'task', 'memory.changed', 'usage', 'people.changed', 'commitments.changed', 'profile.changed']) on(t, scheduleRefresh)
    const poll = window.setInterval(() => void refresh(), 60_000)
    return () => {
      es.close()
      window.clearInterval(poll)
    }
  }, [refresh, scheduleRefresh, navigate, play])

  const startCheckin = useCallback(
    async (id: string) => {
      const { messages } = await api.startCheckin(id)
      await refresh()
      navigate('#/')
      const first = messages.find((m) => m.role === 'assistant')
      if (first && !played.current.has(first.id)) {
        played.current.add(first.id)
        await play(audioUrlOf(first))
      }
    },
    [refresh, navigate, play],
  )

  const say = useCallback(
    async (text: string, via: 'voice' | 'text') => {
      player.stop()
      setPending({ text, via })
      setThinking(true)
      navigate('#/')
      try {
        const live = stateRef.current?.live
        const out = live ? await api.say(live.id, text, via) : await api.sayAnywhere(text, via)
        played.current.add(out.message.id)
        await refresh()
        setPending(null)
        await play(out.audioUrl)
      } catch (err) {
        setPending(null)
        throw err
      } finally {
        setThinking(false)
      }
    },
    [refresh, play, navigate],
  )

  const endCheckin = useCallback(
    async (id: string) => {
      player.stop()
      await api.endCheckin(id)
      await refresh()
      navigate('#/')
    },
    [refresh, navigate],
  )

  const skipCheckin = useCallback(
    async (id: string) => {
      player.stop()
      await api.skipCheckin(id)
      await refresh()
      navigate('#/')
    },
    [refresh, navigate],
  )

  const thinkNow = useCallback(async () => {
    await api.think()
    await refresh()
  }, [refresh])

  const value = useMemo<Store>(
    () => ({ state, error, route, connected, thinking, speaking, soundOn, brainBusy, pending, refresh, navigate, enableSound, play, stopAudio: () => player.stop(), startCheckin, say, endCheckin, skipCheckin, thinkNow }),
    [state, error, route, connected, thinking, speaking, soundOn, brainBusy, pending, refresh, navigate, enableSound, play, startCheckin, say, endCheckin, skipCheckin, thinkNow],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStore(): Store {
  const s = useContext(Ctx)
  if (!s) throw new Error('useStore outside provider')
  return s
}
