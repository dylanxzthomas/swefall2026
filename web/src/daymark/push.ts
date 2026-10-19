import { PushNotifications } from '@capacitor/push-notifications'
import { Preferences } from '@capacitor/preferences'
import { native } from './session'
const key = 'daymark.push-token.v1'
export async function registerPhone() {
  if (!native) throw new Error('Enable notifications from the iPhone app.')
  let permission = await PushNotifications.checkPermissions()
  if (permission.receive === 'prompt') permission = await PushNotifications.requestPermissions()
  if (permission.receive !== 'granted') throw new Error('Notifications are off in iPhone Settings. Your work remains available in Daymark.')
  return new Promise<string>((resolve, reject) => {
    const listeners: { remove(): Promise<void> }[] = []
    let finished = false
    const done = (token?: string) => { if (finished) return; finished = true; clearTimeout(timer); for (const l of listeners) void l.remove(); if (token) resolve(token); else reject(new Error('Phone registration could not finish. Check notification permissions and try again.')) }
    const timer = setTimeout(() => done(), 15000)
    void (async () => {
      listeners.push(await PushNotifications.addListener('registration', async token => { await Preferences.set({ key, value: token.value }); done(token.value) }))
      listeners.push(await PushNotifications.addListener('registrationError', () => done()))
      await PushNotifications.register()
    })().catch(() => done())
  })
}
export async function unregisterPhone(remove: (token: string) => Promise<unknown>) {
  const { value } = await Preferences.get({ key })
  if (value) await remove(value)
  if (native) { await PushNotifications.unregister(); await PushNotifications.removeAllDeliveredNotifications() }
  await Preferences.remove({ key })
}
