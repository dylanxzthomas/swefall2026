import type { ButtonHTMLAttributes, ReactNode } from 'react'
import type { CheckinStatus } from '../../../shared/types'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-ink hover:brightness-110',
  secondary: 'bg-paper-2 text-ink border border-line hover:border-line-2',
  ghost: 'text-ink-2 hover:text-ink hover:bg-paper-2',
  danger: 'text-danger hover:bg-danger-soft',
}

export function Button({ variant = 'secondary', size = 'md', className = '', children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg' }) {
  const pad = size === 'sm' ? 'h-8 px-3 text-[13px]' : size === 'lg' ? 'h-11 px-5' : 'h-9 px-4 text-[14px]'
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center gap-2 rounded-full font-medium transition active:translate-y-px disabled:opacity-50 disabled:pointer-events-none ${pad} ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  )
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-card border border-line bg-paper-2 ${className}`}>{children}</div>
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-4">
      <h2 className="text-[15px] font-medium tracking-tight text-ink">{children}</h2>
      {right}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-card border border-dashed border-line px-4 py-6 text-center text-[14px] text-ink-3">{children}</p>
}

const statusStyles: Record<CheckinStatus, string> = {
  scheduled: 'text-ink-3 border-line',
  prepared: 'text-accent border-accent/40 bg-accent-soft',
  live: 'text-accent-ink bg-accent border-accent',
  done: 'text-ink-2 border-line',
  skipped: 'text-ink-3 border-line',
  missed: 'text-danger border-danger/30 bg-danger-soft',
}
const statusLabel: Record<CheckinStatus, string> = {
  scheduled: 'Not yet prepared',
  prepared: 'Prepared',
  live: 'Live',
  done: 'Done',
  skipped: 'Skipped',
  missed: 'Missed',
}

export function StatusPill({ status }: { status: CheckinStatus }) {
  return <span className={`inline-flex h-6 items-center rounded-full border px-2.5 text-[12px] font-medium ${statusStyles[status]}`}>{statusLabel[status]}</span>
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="text-[12.5px] text-ink-3">{hint}</span>}
    </label>
  )
}

export const inputCls = 'h-9 w-full rounded-lg border border-line bg-paper-2 px-3 text-[14px] text-ink outline-none placeholder:text-ink-3 focus:border-accent'
export const textareaCls = 'w-full rounded-lg border border-line bg-paper-2 px-3 py-2 text-[14px] leading-relaxed text-ink outline-none placeholder:text-ink-3 focus:border-accent'

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="flex items-center gap-3 text-left">
      <span className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition ${checked ? 'bg-accent' : 'bg-line-2'}`}>
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-paper-2 transition ${checked ? 'left-[18px]' : 'left-0.5'}`} />
      </span>
      <span className="text-[14px] text-ink">{label}</span>
    </button>
  )
}

export function Evidence({ items }: { items: string[] }) {
  if (!items.length) return null
  return (
    <ul className="mt-1.5 flex flex-col gap-1">
      {items.map((e, i) => (
        <li key={i} className="border-l-2 border-line pl-2.5 text-[12.5px] leading-snug text-ink-2">
          {e}
        </li>
      ))}
    </ul>
  )
}
