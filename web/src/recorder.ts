import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'

interface RecognitionLike extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
}

declare global {
  interface Window {
    webkitSpeechRecognition?: new () => RecognitionLike
    SpeechRecognition?: new () => RecognitionLike
  }
}

export type RecorderMode = 'server' | 'browser' | 'none'

export interface Recorder {
  mode: RecorderMode
  recording: boolean
  transcribing: boolean
  interim: string
  start(): Promise<void>
  stop(): void
  error: string | null
}

/** Hold to talk. With a server transcriber we record audio and upload it; otherwise the browser's own recognition does the listening. */
export function useRecorder(serverStt: boolean, onText: (text: string) => void): Recorder {
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [interim, setInterim] = useState('')
  const [error, setError] = useState<string | null>(null)
  const mediaRef = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const recRef = useRef<RecognitionLike | null>(null)
  const finalRef = useRef('')
  const onTextRef = useRef(onText)
  onTextRef.current = onText

  const Recognition = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : undefined
  const mode: RecorderMode = serverStt && typeof MediaRecorder !== 'undefined' ? 'server' : Recognition ? 'browser' : 'none'

  const start = useCallback(async () => {
    setError(null)
    if (recording) return
    if (mode === 'server') {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : ''
        const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
        chunks.current = []
        mr.ondataavailable = (e) => {
          if (e.data.size) chunks.current.push(e.data)
        }
        mr.onstop = async () => {
          stream.getTracks().forEach((t) => t.stop())
          const blob = new Blob(chunks.current, { type: mr.mimeType || 'audio/webm' })
          if (blob.size < 1000) return
          setTranscribing(true)
          try {
            const { text } = await api.stt(blob)
            if (text.trim()) onTextRef.current(text.trim())
            else setError('I did not catch that.')
          } catch (err) {
            setError((err as Error).message)
          } finally {
            setTranscribing(false)
          }
        }
        mediaRef.current = mr
        mr.start()
        setRecording(true)
      } catch (err) {
        setError(`Microphone: ${(err as Error).message}`)
      }
      return
    }
    if (mode === 'browser' && Recognition) {
      const rec = new Recognition()
      rec.continuous = true
      rec.interimResults = true
      rec.lang = navigator.language || 'en-US'
      finalRef.current = ''
      rec.onresult = (e) => {
        let fin = ''
        let inter = ''
        for (let i = 0; i < e.results.length; i++) {
          const r = e.results[i]
          if (r.isFinal) fin += r[0].transcript
          else inter += r[0].transcript
        }
        finalRef.current = fin
        setInterim(inter)
      }
      rec.onerror = (e) => {
        if (e.error !== 'aborted' && e.error !== 'no-speech') setError(`Speech recognition: ${e.error}`)
      }
      rec.onend = () => {
        setRecording(false)
        setInterim('')
        const text = finalRef.current.trim()
        if (text) onTextRef.current(text)
        recRef.current = null
      }
      recRef.current = rec
      rec.start()
      setRecording(true)
      return
    }
    setError('No microphone path available in this browser. Type instead.')
  }, [mode, recording, Recognition])

  const stop = useCallback(() => {
    if (mode === 'server' && mediaRef.current && mediaRef.current.state !== 'inactive') {
      mediaRef.current.stop()
      mediaRef.current = null
      setRecording(false)
    } else if (mode === 'browser' && recRef.current) {
      recRef.current.stop()
    }
  }, [mode])

  useEffect(() => () => {
    if (mediaRef.current && mediaRef.current.state !== 'inactive') mediaRef.current.stop()
    if (recRef.current) recRef.current.abort()
  }, [])

  return { mode, recording, transcribing, interim, start, stop, error }
}
