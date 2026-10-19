import type { AvatarMood } from '../../../shared/avatar'

export const avatarExpressions: Record<AvatarMood, { label: string; description: string; src: string }> = {
  idle: { label: 'Calm', description: 'A soft settling motion when you arrive.', src: '/avatars/companion.png?v=3' },
  listening: { label: 'Listening', description: 'An attentive lean while you write.', src: '/avatars/sola-listening.png' },
  working: { label: 'Preparing', description: 'A gentle sway as a request starts preparing.', src: '/avatars/sola-working.png' },
  review: { label: 'Ready for you', description: 'A small nod when something needs your review.', src: '/avatars/sola-review.png' },
  done: { label: 'Pleased', description: 'A little lift once the result has a receipt.', src: '/avatars/sola-done.png' },
  resting: { label: 'Resting', description: 'A quiet breath while work waits for its next step.', src: '/avatars/sola-resting.png' },
}
