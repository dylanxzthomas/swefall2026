/** WKWebView can retain the document pan it used to reveal an editable control.
 * Restore the parent's reading position only after a measured keyboard cycle.
 * Dialogs keep their own scroll position; browser and hardware-keyboard focus
 * never enter this native-only recovery path.
 */
export function preserveNativeKeyboardScroll(win: Window, doc: Document) {
  const viewport = win.visualViewport
  if (!viewport) return () => {}
  type Position = { x: number; y: number; height: number; width: number; scale: number; opened: boolean }
  let position: Position | undefined, frame: number | undefined
  const editable = (value: EventTarget | null) => {
    const element = value as HTMLInputElement | null
    return !!element && (element.isContentEditable || !!element.matches?.('input, textarea') && !element.disabled && !element.readOnly && !/^(button|submit|reset|checkbox|radio|range|color|file|hidden)$/.test(element.type))
  }
  const cancelFrame = () => { if (frame !== undefined) win.cancelAnimationFrame(frame); frame = undefined }
  const capture = () => ({ x: win.scrollX, y: win.scrollY, height: viewport.height, width: viewport.width, scale: viewport.scale, opened: false })
  const check = () => {
    if (!position) return
    // A rotation or zoom is not a keyboard dismissal and has its own geometry.
    if (Math.abs(viewport.width - position.width) > 2 || Math.abs(viewport.scale - position.scale) > .01) { position = undefined; cancelFrame(); return }
    const shrink = position.height - viewport.height
    if (shrink > 120) position.opened = true
    if (!position.opened || shrink > 2 || editable(doc.activeElement)) return
    cancelFrame()
    frame = win.requestAnimationFrame(() => {
      frame = undefined
      if (!position || editable(doc.activeElement) || Math.abs(viewport.height - position.height) > 2) return
      const { x, y } = position
      position = undefined
      win.scrollTo({ left: x, top: y, behavior: 'instant' })
    })
  }
  const focus = (event: Event) => {
    if (!editable(event.target)) return
    cancelFrame()
    // Preserve the original position when moving between fields with the same
    // keyboard open. A new focus after dismissal starts a separate cycle.
    if (!position?.opened || position.height - viewport.height <= 2) position = capture()
  }
  const blur = () => { cancelFrame(); frame = win.requestAnimationFrame(() => { frame = undefined; check() }) }
  doc.addEventListener('focusin', focus)
  doc.addEventListener('focusout', blur)
  viewport.addEventListener('resize', check)
  viewport.addEventListener('scroll', check)
  return () => {
    position = undefined; cancelFrame()
    doc.removeEventListener('focusin', focus)
    doc.removeEventListener('focusout', blur)
    viewport.removeEventListener('resize', check)
    viewport.removeEventListener('scroll', check)
  }
}
