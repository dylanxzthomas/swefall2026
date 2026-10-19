import { Capacitor, registerPlugin } from '@capacitor/core'
import type { NativeCalendarChoice, NativeCalendarOperation, NativeCalendarResult, NativeCalendarState, NativeEvent } from '../../../shared/nativeCalendar'
type Permission = Pick<NativeCalendarState, 'permission'> & { calendars: NativeCalendarChoice[] }
export interface NativeCalendarBridge {
  installation?(): Promise<{ deviceId: string }>;
  status(): Promise<Permission>;
  connect(): Promise<Permission>;
  read(args: { eventId: string; calendarId: string }): Promise<{ event: NativeEvent }>;
  execute(args: { operation: NativeCalendarOperation }): Promise<NativeCalendarResult>;
  reconcile(args: { operation: NativeCalendarOperation }): Promise<NativeCalendarResult>;
}
const plugin = registerPlugin<NativeCalendarBridge>('DaymarkCalendar')
export function createNativeCalendar(bridge: NativeCalendarBridge = plugin, available = () => Capacitor.getPlatform() === 'ios') {
  function requireNative() { if (!available()) throw new Error('Apple Calendar is available in the Daymark iPhone app.') }
  return {
    available,
    installation: async () => { requireNative(); if (!bridge.installation) throw new Error('Update the iPhone app to connect this calendar.'); return (await bridge.installation()).deviceId },
    status: async () => { requireNative(); return bridge.status() },
    connect: async () => { requireNative(); return bridge.connect() },
    read: async (args: { eventId: string; calendarId: string }) => { requireNative(); return (await bridge.read(args)).event },
    execute: async (operation: NativeCalendarOperation) => { requireNative(); return bridge.execute({ operation }) },
    reconcile: async (operation: NativeCalendarOperation) => { requireNative(); return bridge.reconcile({ operation }) },
  }
}
export const nativeCalendar = createNativeCalendar()
