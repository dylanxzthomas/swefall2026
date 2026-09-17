import type { Config } from './config.js'

export const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

export function dayKey(d: Date): string {
  return DAY_KEYS[d.getDay()]
}

export function ymd(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function atTime(ymdStr: string, hhmm: string): Date {
  const [y, m, d] = ymdStr.split('-').map(Number)
  const [h, mi] = hhmm.split(':').map(Number)
  return new Date(y, m - 1, d, h, mi, 0, 0)
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

export function addMinutes(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 60_000)
}

export function minutesBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 60_000
}

export function fmtTime(d: Date | string): string {
  return new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

export function fmtDay(d: Date | string): string {
  return new Date(d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

export function fmtDateTime(d: Date | string): string {
  return `${fmtDay(d)} ${fmtTime(d)}`
}

export function fmtNowLong(d = new Date(), tz?: string): string {
  return d.toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: tz,
  })
}

export function isQuiet(cfg: Config, d = new Date()): boolean {
  const cur = d.getHours() * 60 + d.getMinutes()
  const [sh, sm] = cfg.quietHours.start.split(':').map(Number)
  const [eh, em] = cfg.quietHours.end.split(':').map(Number)
  const s = sh * 60 + sm
  const e = eh * 60 + em
  return s <= e ? cur >= s && cur < e : cur >= s || cur < e
}

export function relative(d: Date | string, from = new Date()): string {
  const mins = Math.round(minutesBetween(from, new Date(d)))
  const abs = Math.abs(mins)
  const past = mins < 0
  let s: string
  if (abs < 1) s = 'now'
  else if (abs < 60) s = `${abs} min`
  else if (abs < 60 * 36) s = `${Math.round(abs / 60)} h`
  else s = `${Math.round(abs / 1440)} d`
  if (s === 'now') return s
  return past ? `${s} ago` : `in ${s}`
}
