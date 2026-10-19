export const assistantDefaultName = 'Sola'
export const assistantAvatars = ['robin', 'initial'] as const
export type AssistantAvatar = typeof assistantAvatars[number]
export function assistantName(preferences?: { assistantName?: string }) { const name = preferences?.assistantName?.trim(); return !name || name === 'Daymark' ? assistantDefaultName : name }
export function householdLabel(household?: { name?: string } | null) { return household?.name?.trim() || 'Your household' }
