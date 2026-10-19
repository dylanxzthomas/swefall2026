'use node'
import { v } from 'convex/values'
import { PDFDocument } from 'pdf-lib'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { internalAction } from './_generated/server'
import { internal } from './_generated/api'
export async function validateDocument(data: Uint8Array): Promise<{ mediaType: string; data: Uint8Array }> {
  const header = Buffer.from(data.slice(0, 24))
  if (header.subarray(0, 5).toString() === '%PDF-') {
    const doc = await PDFDocument.load(data, { ignoreEncryption: false, updateMetadata: false })
    if (doc.getPageCount() > 10 || doc.getPageCount() < 1) throw new Error('Share a PDF with 1–10 pages.')
    return { mediaType: 'application/pdf', data }
  }
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return { mediaType: 'image/jpeg', data }
  if (header.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { mediaType: 'image/png', data }
  if (header.subarray(4,8).toString() === 'ftyp' && /heic|heix|hevc|hevx|mif1|msf1/.test(header.subarray(8).toString())) {
    const convert = (await import('heic-convert')).default
    const output = await convert({ buffer: Buffer.from(data), format: 'JPEG', quality: .9 })
    return { mediaType: 'image/jpeg', data: new Uint8Array(output) }
  }
  throw new Error('Share a JPG, PNG, HEIC image, or an unencrypted PDF.')
}
export const validate = internalAction({ args: { id: v.id('attachments') }, handler: async (ctx, { id }): Promise<void> => {
  const file = await ctx.runQuery(internal.intake.privateFile, { id })
  if (!file || file.status !== 'checking') return
  try {
    const blob = await ctx.storage.get(file.storageId)
    if (!blob || blob.size > 10 * 1024 * 1024 || !blob.size) throw new Error('File must be between 1 byte and 10 MB.')
    const original = new Uint8Array(await blob.arrayBuffer()), validated = await validateDocument(original)
    if (validated.data.byteLength > 10 * 1024 * 1024) throw new Error('File must be under 10 MB after image conversion.')
    const replacement = validated.data !== original ? await ctx.storage.store(new Blob([Buffer.from(validated.data)], { type: validated.mediaType })) : undefined
    const saved = await ctx.runMutation(internal.intake.validated, { id, hash: bytesToHex(sha256(validated.data)), storageId: replacement ?? file.storageId, mediaType: validated.mediaType, size: validated.data.byteLength, ...(replacement ? { name: file.name.replace(/\.[^.]+$/, '') + '.jpg' } : {}) })
    if (saved && replacement) await ctx.storage.delete(file.storageId)
    if (!saved && replacement) await ctx.storage.delete(replacement)
  } catch (e) {
    const error = (e as Error).message
    await ctx.runMutation(internal.intake.validated, { id, error: /encrypted/i.test(error) ? 'This PDF is encrypted. Share an unencrypted copy.' : /Share|File must/.test(error) ? error : 'This file could not be read. Share a JPG, PNG, HEIC, or unencrypted PDF.' })
    await ctx.storage.delete(file.storageId)
  }
} })
