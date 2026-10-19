import { Capacitor } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'
import { Share } from '@capacitor/share'
import { createLocalStore } from './store'

export const isNative = Capacitor.isNativePlatform()
// Isolated browser preview exercises the on-device data path without touching server data.
export const isDevicePreview = !isNative && new URLSearchParams(location.search).get('mobile-preview') === '1'
export const isLocal = isNative || isDevicePreview
const key = isNative ? 'wren.household.v1' : 'wren.mobile-preview.v1'
const store = createLocalStore({
  read: async () => (await Preferences.get({ key })).value,
  write: async value => { await Preferences.set({ key, value }) },
})
export const localRequest = store.request
export const sharePlan = async (text: string) => { await Share.share({ title: 'Family plan', text, dialogTitle: 'Share your plan' }) }
