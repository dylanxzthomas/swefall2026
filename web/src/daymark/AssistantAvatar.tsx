import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { assistantDefaultName, type AssistantAvatar as AvatarChoice } from '../../../shared/persona'
import type { AvatarMood } from '../../../shared/avatar'
import { avatarExpressions } from './avatarExpressions'
import './persona.css'

export default function AssistantAvatar({ name, avatar = 'robin', size = 40, className = '', mood = 'idle', animate = false, replay = 0 }: { name: string; avatar?: AvatarChoice; size?: number; className?: string; mood?: AvatarMood; animate?: boolean; replay?: number }) {
  const [failed, setFailed] = useState<string[]>([]), [loaded, setLoaded] = useState('')
  const [paused, setPaused] = useState(() => document.hidden), frame = useRef<HTMLSpanElement>(null)
  const requested = avatarExpressions[mood].src, fallback = avatarExpressions.idle.src
  const src = failed.includes(requested) ? fallback : requested
  const showImage = avatar === 'robin' && !failed.includes(src)
  useEffect(() => {
    if (!animate || !showImage) return
    let visible = true
    const update = () => setPaused(document.hidden || !visible)
    const observer = new IntersectionObserver(entries => { visible = entries.some(entry => entry.isIntersecting); update() })
    if (frame.current) observer.observe(frame.current)
    document.addEventListener('visibilitychange', update); update()
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', update) }
  }, [animate, showImage])
  return <span ref={frame} className={`dm-avatar ${className}`} style={{ '--avatar-size': `${size}px` } as CSSProperties} aria-hidden="true" data-mood={mood} data-animate={animate && showImage && loaded === src && src === requested} data-paused={paused}>
    {showImage ? <img key={`${src}:${replay}`} src={src} alt="" decoding="async" onLoad={() => setLoaded(src)} onError={() => setFailed(values => values.includes(src) ? values : [...values, src])} draggable={false} /> : <span className="dm-avatar-initial">{Array.from(name.trim())[0]?.toLocaleUpperCase() || assistantDefaultName[0]}</span>}
  </span>
}
