import { Preferences } from '@capacitor/preferences'
import { sourceHash } from '../../../shared/daymark'

// Acknowledges the disclosed audio use, never microphone permission or tool approval.
// New adults, backends, processing modes or disclosure versions need their own choice.
export function voiceConsentKey(owner: string, tools: boolean, backend = import.meta.env.VITE_CONVEX_URL ?? '') {
  return `daymark.voice-consent.v2:${sourceHash(JSON.stringify([owner, backend, tools]))}`
}
export async function rememberedVoiceConsent(key: string) {
  try { return (await Preferences.get({ key })).value === 'accepted' } catch { return false }
}
export async function rememberVoiceConsent(key: string) { await Preferences.set({ key, value: 'accepted' }) }
export async function forgetVoiceConsent(key: string) { await Preferences.remove({ key }) }
