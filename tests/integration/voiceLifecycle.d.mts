export class VoiceDeadline extends Error { category: string; constructor(category: string) }
export function within<T>(work: () => T | Promise<T>, milliseconds: number, category?: string): Promise<T>
export function armVoiceWatchdog(options: { afterMs: number; stop(): unknown | Promise<unknown>; killBrowser(): void; report?(status: 'stopped' | 'stop_failed' | 'browser_killed'): void; stopMs?: number; teardownMs?: number }): { dispose(): void }
export function closeBounded(close: () => unknown | Promise<unknown>, force: () => void, milliseconds?: number): Promise<boolean>
