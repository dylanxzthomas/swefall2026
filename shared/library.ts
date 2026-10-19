import { z } from 'zod'
import { assistantAvatars, assistantDefaultName } from './persona.js'
export type LibraryItem = { id: string; kind: 'artifact' | 'media'; title: string; collection: string; childId?: string; pinned: boolean; createdAt: number; version: number; actionId?: string; jobId?: string; fileId?: string; mediaType?: string; size?: number }
export const libraryChangesSchema = z.object({ title: z.string().trim().min(1, 'Give this item a title.').max(200), collection: z.string().trim().max(80), childId: z.string().max(100).optional(), pinned: z.boolean() })
export const preferencesSchema = z.object({ parentName: z.string().trim().max(80), assistantName: z.string().trim().min(1, 'Give your assistant a name.').max(40), avatar: z.enum(assistantAvatars).optional() })
export const defaultPreferences = { parentName: '', assistantName: assistantDefaultName, avatar: 'robin' as const }
export const libraryMediaTypes = ['image/jpeg', 'image/png', 'image/heic', 'application/pdf'] as const
export function validateLibraryFiles(files: { size: number; mediaType: string }[]) {
  if (!files.length || files.length > 5 || files.some(f => f.size <= 0 || !libraryMediaTypes.includes(f.mediaType as typeof libraryMediaTypes[number])) || files.reduce((sum, f) => sum + f.size, 0) > 10 * 1024 * 1024 || files.some(f => f.mediaType === 'application/pdf') && files.length !== 1) throw new Error('Choose up to five JPG, PNG, or HEIC images, or one PDF, 10 MB total.')
}
