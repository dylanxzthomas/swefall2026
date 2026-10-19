import { Capacitor, registerPlugin } from '@capacitor/core'
import type { ICache } from '@auth0/auth0-spa-js'
import { nativeTransaction } from '../../../shared/nativeTransaction'
const Keychain = registerPlugin<{ get(args: { key: string }): Promise<{ value?: string }>; set(args: { key: string; value: string }): Promise<void>; remove(args: { key: string }): Promise<void>; keys(): Promise<{ keys: string[] }> }>('DaymarkKeychain')
export const native = Capacitor.isNativePlatform()
export const nativeCache: ICache = {
  async get<T>(key: string) { const { value } = await Keychain.get({ key }); return value ? JSON.parse(value) as T : undefined },
  async set<T>(key: string, entry: T) { await Keychain.set({ key, value: JSON.stringify(entry) }) },
  async remove(key: string) { await Keychain.remove({ key }) },
  async allKeys() { return (await Keychain.keys()).keys },
}
export const nativeCallback = `com.dylanxzthomas.wren://${import.meta.env.VITE_AUTH0_DOMAIN}/capacitor/com.dylanxzthomas.wren/callback`
export const signInTransaction = nativeTransaction(import.meta.env.VITE_AUTH0_NATIVE_CLIENT_ID ?? '', {
  get: async key => (await Keychain.get({ key })).value,
  set: (key, value) => Keychain.set({ key, value }),
  remove: key => Keychain.remove({ key }),
}, window.sessionStorage)
