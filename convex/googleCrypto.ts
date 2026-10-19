'use node'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { providerEncryptionConfigured } from './providerConfiguration'
export function seal(value: unknown, binding: string): string {
  if (!providerEncryptionConfigured()) throw new Error('Provider token encryption is not configured correctly.')
  const id = process.env.PROVIDER_TOKEN_KEY_ID || process.env.GOOGLE_TOKEN_KEY_ID
  const keys = JSON.parse(process.env.PROVIDER_TOKEN_KEYS || process.env.GOOGLE_TOKEN_KEYS || '{}') as Record<string, string>
  if (!id || !keys[id]) throw new Error('Provider token encryption is not configured.')
  const key = Buffer.from(keys[id], 'base64')
  if (key.length !== 32) throw new Error('Provider encryption key must be 32 bytes.')
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(binding))
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return [id, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.')
}
export function unseal<T>(value: string, binding: string): T {
  const parts = value.split('.')
  const [id, iv, tag, data] = parts
  if (parts.length !== 4 || !/^[a-zA-Z0-9_-]{1,64}$/.test(id) || ![iv, tag, data].every(part => /^[a-zA-Z0-9_-]+$/.test(part)) || Buffer.from(iv, 'base64url').length !== 12 || Buffer.from(tag, 'base64url').length !== 16) throw new Error('Invalid encrypted token envelope.')
  const keys = JSON.parse(process.env.PROVIDER_TOKEN_KEYS || process.env.GOOGLE_TOKEN_KEYS || '{}') as Record<string, string>
  if (!Object.hasOwn(keys, id) || typeof keys[id] !== 'string' || Buffer.from(keys[id], 'base64').length !== 32) throw new Error('Token encryption key is unavailable.')
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keys[id], 'base64'), Buffer.from(iv, 'base64url'))
  decipher.setAAD(Buffer.from(binding)); decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8'))
}
