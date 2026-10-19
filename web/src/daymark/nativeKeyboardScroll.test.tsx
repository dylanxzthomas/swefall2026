import { expect, it, vi } from 'vitest'
import { preserveNativeKeyboardScroll } from './nativeKeyboardScroll'

function fixture() {
  const listeners = new Map<string, Set<(event: any) => void>>()
  const surface = (name: string) => ({
    addEventListener: (type: string, listener: any) => { const key = name + type; if (!listeners.has(key)) listeners.set(key, new Set()); listeners.get(key)!.add(listener) },
    removeEventListener: (type: string, listener: any) => listeners.get(name + type)?.delete(listener),
    emit: (type: string, event: any = {}) => listeners.get(name + type)?.forEach(listener => listener(event)),
  })
  const frames = new Map<number, FrameRequestCallback>(); let next = 0
  const viewport = { ...surface('viewport'), height: 800, width: 400, scale: 1 }
  const doc = { ...surface('document'), activeElement: null as any }
  const win = { visualViewport: viewport, scrollX: 0, scrollY: 420, scrollTo: vi.fn(), requestAnimationFrame: (fn: FrameRequestCallback) => { frames.set(++next, fn); return next }, cancelAnimationFrame: (id: number) => { frames.delete(id) } }
  const stop = preserveNativeKeyboardScroll(win as any, doc as any)
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(0)) }
  const field = () => ({ matches: () => true, disabled: false, readOnly: false, type: 'text', scrollTop: 170 })
  const focus = (element = field()) => { doc.activeElement = element; doc.emit('focusin', { target: element }); return element }
  const resize = (height: number) => { viewport.height = height; viewport.emit('resize') }
  const blur = () => { doc.activeElement = null; doc.emit('focusout') }
  return { win, doc, viewport, focus, resize, blur, stop, flush, frames, listeners }
}
it('restores the captured nonzero reading position only after keyboard dismissal and blur', () => {
  const f = fixture(); const field = f.focus(); f.resize(470); f.win.scrollY = 610
  f.resize(800); f.flush(); expect(f.win.scrollTo).not.toHaveBeenCalled()
  f.blur(); f.flush(); f.flush()
  expect(f.win.scrollTo).toHaveBeenCalledExactlyOnceWith({ left: 0, top: 420, behavior: 'instant' })
  expect(field.scrollTop).toBe(170)
})
it('waits for the entire keyboard animation instead of restoring at an intermediate viewport height', () => {
  const f = fixture(); f.focus(); f.resize(470); f.blur(); f.flush(); f.resize(740); f.flush()
  expect(f.win.scrollTo).not.toHaveBeenCalled(); f.resize(800); f.flush()
  expect(f.win.scrollTo).toHaveBeenCalledOnce()
})
it('keeps the original root position across a focus handoff without scrolling an active editor', () => {
  const f = fixture(); f.focus(); f.resize(470); f.win.scrollY = 610; f.blur(); f.focus(); f.flush()
  f.resize(800); f.flush(); expect(f.win.scrollTo).not.toHaveBeenCalled()
  f.blur(); f.flush(); f.flush(); expect(f.win.scrollTo).toHaveBeenCalledWith({ left: 0, top: 420, behavior: 'instant' })
})
it('cancels a pending restoration when a new focus starts after the viewport recovers', () => {
  const f = fixture(); f.focus(); f.resize(470); f.blur(); f.resize(800); f.win.scrollY = 700; f.focus(); f.flush()
  expect(f.win.scrollTo).not.toHaveBeenCalled()
  f.resize(470); f.blur(); f.resize(800); f.flush()
  expect(f.win.scrollTo).toHaveBeenCalledExactlyOnceWith({ left: 0, top: 700, behavior: 'instant' })
})
it('does not treat hardware-keyboard focus, browser bars or ordinary root scrolling as a software keyboard', () => {
  const f = fixture(); f.focus(); f.win.scrollY = 600; f.resize(750); f.blur(); f.resize(800); f.flush(); f.flush()
  expect(f.win.scrollTo).not.toHaveBeenCalled()
})
it('allows recovery when focus moved to a noneditable button control', () => {
  const f = fixture(); f.focus(); f.resize(470); f.blur(); f.doc.activeElement = { matches: () => true, type: 'button' }; f.resize(800); f.flush()
  expect(f.win.scrollTo).toHaveBeenCalledExactlyOnceWith({ left: 0, top: 420, behavior: 'instant' })
})
it.each(['width', 'scale'] as const)('abandons restoration when %s changes during editing', key => {
  const f = fixture(); f.focus(); f.resize(470); f.viewport[key] += key === 'width' ? 300 : .5
  f.blur(); f.resize(800); f.flush(); f.flush(); expect(f.win.scrollTo).not.toHaveBeenCalled()
})
it('ignores a readonly field and removes queued work and all event listeners on unmount', () => {
  const f = fixture(); f.focus({ matches: () => true, disabled: false, readOnly: true, type: 'text', scrollTop: 0 }); f.resize(470); f.blur(); f.resize(800); f.flush(); f.flush()
  expect(f.win.scrollTo).not.toHaveBeenCalled()
  f.focus(); f.resize(470); f.blur(); f.resize(800); f.stop(); f.flush()
  expect(f.win.scrollTo).not.toHaveBeenCalled(); expect(f.frames.size).toBe(0)
  expect([...f.listeners.values()].every(list => list.size === 0)).toBe(true)
})
it('is inert when the native WebView has no visual viewport API', () => {
  const win = { visualViewport: null, addEventListener: vi.fn() }
  preserveNativeKeyboardScroll(win as any, {} as Document)(); expect(win.addEventListener).not.toHaveBeenCalled()
})
