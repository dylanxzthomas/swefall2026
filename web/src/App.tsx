import { Brain, CalendarBlank, ChatCircle, GearSix, SpeakerSlash, Users } from '@phosphor-icons/react'
import { Presence } from './components/Presence'
import { useStore } from './store'
import { Talk } from './views/Talk'
import { Schedule } from './views/Schedule'
import { People } from './views/People'
import { Memory } from './views/Memory'
import { Settings } from './views/Settings'

export default function App() {
  const { state, error, route, connected, soundOn, enableSound } = useStore()
  const nav = [
    { hash: '#/', label: 'Talk', icon: ChatCircle, active: route.name === 'talk' },
    { hash: '#/schedule', label: 'Schedule', icon: CalendarBlank, active: route.name === 'schedule' },
    { hash: '#/people', label: 'People', icon: Users, active: route.name === 'people' },
    { hash: '#/memory', label: 'Memory', icon: Brain, active: route.name === 'memory' },
    { hash: '#/settings', label: 'Settings', icon: GearSix, active: route.name === 'settings' },
  ]

  let view: JSX.Element
  switch (route.name) {
    case 'schedule':
      view = <Schedule />
      break
    case 'people':
      view = <People id={route.id} />
      break
    case 'memory':
      view = <Memory />
      break
    case 'settings':
      view = <Settings />
      break
    default:
      view = <Talk id={route.id} />
  }

  return (
    <div className="flex h-full flex-col lg:flex-row">
      <aside className="flex shrink-0 flex-col border-b border-line lg:w-[240px] lg:border-b-0 lg:border-r">
        <div className="px-5 pb-3 pt-5">
          <Presence compact />
        </div>
        <nav className="flex gap-1 px-3 pb-3 lg:flex-col">
          {nav.map((n) => (
            <a key={n.hash} href={n.hash} title={n.label} className={`flex items-center gap-2.5 rounded-full px-3 py-1.5 text-[14px] ${n.active ? 'bg-paper-2 font-medium text-ink' : 'text-ink-2 hover:text-ink'}`}>
              <n.icon size={17} /> <span className="hidden sm:inline">{n.label}</span>
            </a>
          ))}
        </nav>
        {state && (state.providers.brain === 'mock' || !connected) && (
          <div className="mt-auto hidden px-5 py-5 text-[12.5px] leading-relaxed text-ink-3 lg:block">
            {state.providers.brain === 'mock' && <div>No brain yet.</div>}
            {!connected && <div className="text-danger">Reconnecting.</div>}
          </div>
        )}
      </aside>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
        {!soundOn && (
          <button type="button" onClick={() => void enableSound()} className="flex items-center justify-center gap-2 border-b border-line bg-paper-2 py-2 text-[13px] text-ink-2 hover:text-ink">
            <SpeakerSlash size={15} /> Click anywhere to let {state?.assistant.name ?? 'the assistant'} speak in this tab.
          </button>
        )}
        {error && <div className="border-b border-line px-6 py-2 text-[13px] text-danger">Can't reach the server: {error}</div>}
        <div className="min-h-0 flex-1">{view}</div>
      </main>
    </div>
  )
}
