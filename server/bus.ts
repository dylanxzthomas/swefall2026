import { EventEmitter } from 'node:events'

export interface BusEvent {
  type: string
  data: unknown
  at: string
}

export const bus = new EventEmitter()
bus.setMaxListeners(50)

export function emit(type: string, data: unknown = {}): void {
  const evt: BusEvent = { type, data, at: new Date().toISOString() }
  bus.emit('event', evt)
}

let sseClients = 0
export function clientConnected(): void {
  sseClients++
}
export function clientDisconnected(): void {
  sseClients = Math.max(0, sseClients - 1)
}
export function hasConsoleOpen(): boolean {
  return sseClients > 0
}
