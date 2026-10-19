import { registerPlugin } from '@capacitor/core'
export type SharedNotice = { id: string; text: string; files: { name: string; type: string; base64: string }[] }
export const NativeIntake = registerPlugin<{ pending(): Promise<{ notices: SharedNotice[] }>; acknowledge(args: { id: string }): Promise<void> }>('DaymarkIntake')
export function sharedFiles(notice: SharedNotice) { return notice.files.map(f => new File([Uint8Array.from(atob(f.base64), c => c.charCodeAt(0))], f.name, { type: f.type })) }
