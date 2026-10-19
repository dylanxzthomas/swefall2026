import type { ReactNode } from 'react'
import type { AvatarMood } from '../../../shared/avatar'
import type { AssistantAvatar as Avatar } from '../../../shared/persona'
import AssistantAvatar from './AssistantAvatar'

export default function ConversationMessage({ name, avatar, mood, children, activity, outcome = false }: { name: string; avatar?: Avatar; mood?: AvatarMood; children: ReactNode; activity?: string | null; outcome?: boolean }) {
  return <div className={`dm-assistant-message dm-assistant-message-chat dm-conversation-message${outcome ? ' dm-conversation-update' : ''}`}>
    <span className="dm-assistant-byline"><AssistantAvatar name={name} avatar={avatar} size={24} mood={mood} /><span>{name}</span></span>
    <div className="dm-conversation-bubble">{children}{activity && <p className="dm-conversation-activity" role="status" aria-live="polite"><span aria-hidden="true" />{activity}</p>}</div>
  </div>
}
