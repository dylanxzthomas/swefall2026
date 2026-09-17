import type { Checkin, Task } from '../../../shared/types'
import { Empty, Evidence, SectionTitle } from './ui'

/** What the assistant prepared during dead time, so you can see the reasoning behind what it says. */
export function Brief({ checkin, tasks }: { checkin: Checkin; tasks: Task[] }) {
  const s = checkin.script
  return (
    <div className="flex flex-col gap-8">
      <section>
        <SectionTitle>What I prepared</SectionTitle>
        {!s ? (
          <Empty>Not prepared yet. It happens about forty-five minutes before.</Empty>
        ) : s.points.length === 0 ? (
          <p className="text-[14px] text-ink-2">{s.quiet ? 'Nothing worth flagging beyond the opener.' : 'No specific points behind this one.'}</p>
        ) : (
          <ol className="flex flex-col gap-4">
            {s.points.map((p, i) => (
              <li key={i} className="text-[14.5px] leading-relaxed text-ink">
                {p.text}
                <Evidence items={p.evidence ? [p.evidence] : []} />
              </li>
            ))}
          </ol>
        )}
      </section>
      {s && s.people.length > 0 && (
        <section>
          <SectionTitle>People</SectionTitle>
          <ul className="flex flex-col gap-4">
            {s.people.map((p, i) => (
              <li key={i}>
                <div className="text-[14px] font-medium text-ink">{p.name}</div>
                <p className="mt-0.5 text-[14px] leading-relaxed text-ink-2">{p.brief}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {s && s.questions.length > 0 && (
        <section>
          <SectionTitle>I may ask</SectionTitle>
          <ul className="flex flex-col gap-2">
            {s.questions.map((q, i) => (
              <li key={i} className="text-[14px] leading-relaxed text-ink-2">
                {q}
              </li>
            ))}
          </ul>
        </section>
      )}
      {tasks.length > 0 && (
        <section>
          <SectionTitle>Done in this conversation</SectionTitle>
          <ul className="flex flex-col gap-3">
            {tasks.map((t) => (
              <li key={t.id} className="text-[14px]">
                <div className="text-ink-2">"{t.request}"</div>
                <ul className="mt-1 flex flex-col gap-1">
                  {t.steps.map((st, i) => (
                    <li key={i} className="flex gap-2 text-ink">
                      <span className="font-mono text-[12px] text-ink-3">{st.tool}</span>
                      <span>{st.summary}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
