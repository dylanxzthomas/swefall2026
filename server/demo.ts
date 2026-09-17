// Seeds a separate "demo" profile so you can see the console populated before connecting your own life.
// Everything here is invented. Run: npm run demo   then: npm run demo:start
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG_PATH, DATA_DIR, LOCAL_CALENDAR_PATH, PROFILE, PROFILE_PATH, DEFAULT_CONFIG } from './config.js'

if (PROFILE !== 'demo') {
  console.error('Refusing to seed a non-demo profile. Use: npm run demo')
  process.exit(1)
}
for (const f of ['wren.sqlite', 'wren.sqlite-wal', 'wren.sqlite-shm']) {
  const p = path.join(DATA_DIR, f)
  if (fs.existsSync(p)) fs.unlinkSync(p)
}

fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...DEFAULT_CONFIG, server: { port: 4748 }, user: { ...DEFAULT_CONFIG.user, name: 'Dylan' } }, null, 2) + '\n')

const { People, Facts, Commitments, Observations, Events, KV } = await import('./db.js')

const today = new Date()
const at = (dayOffset: number, h: number, m = 0) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + dayOffset, h, m).toISOString()
const daysAgo = (n: number, h = 12) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - n, h).toISOString()
const dateStr = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

fs.writeFileSync(
  PROFILE_PATH,
  `# About Dylan (demo profile)

This is sample data so you can see how Wren works before adding your own. None of it is real.

## Work
- Co-founder of a small health-data company. A pilot with Lattice Health decides the next six months.
- Tom runs engineering; I run product, sales, and everything else.

## People who matter right now
- Priya Natarajan, the pilot sponsor. Marcus Bell, angel and the closest thing to a mentor. Tom Achebe, co-founder.

## What a good week looks like
- Two deep-work mornings. Standup on time. One call with someone I actually like.

## Things I keep putting off
- Replying to recruiters. Calling Elena.

## How I like to be talked to
- Straight. Short. Tell me what you'd do, then let me decide.
`,
)

const priya = People.create({
  name: 'Priya Natarajan',
  emails: ['priya.natarajan@latticehealth.example'],
  role: 'VP Product',
  company: 'Lattice Health',
  relationship: 'Sponsor of the pilot; the person whose yes matters',
  summary: 'Careful, numbers first, hates surprises in a meeting. Has gone to bat for the pilot internally twice.',
  wants: 'A clean go or no-go on the pilot by the 12th, with retention numbers she can put in front of her board.',
  avoid: 'Walking in without the numbers. Vague timelines.',
  last_contact_at: daysAgo(6),
})
Facts.add({ person_id: priya.id, text: 'Her board asks about pilot retention every month.', source: 'conversation', evidence: 'she said the board "asks me about retention every single month"', confidence: 0.9 })
Facts.add({ person_id: priya.id, text: `The check-in on ${dateStr(daysAgo(13))} and the one on ${dateStr(daysAgo(6))} were both moved by Dylan, each the day before.`, source: 'calendar', confidence: 0.95 })
Facts.add({ person_id: priya.id, text: 'Prefers a two-line summary at the top of any doc.', source: 'conversation', evidence: 'asked for "the two lines up top, always"', confidence: 0.8 })

const marcus = People.create({
  name: 'Marcus Bell',
  emails: ['marcus@bellventures.example'],
  role: 'Angel investor',
  company: 'Sold a logistics company in 2021',
  relationship: 'Angel, and the closest thing to a mentor',
  summary: 'Direct, allergic to preamble, twenty-minute meetings. Warm once you get past the first five minutes.',
  wants: 'To see whether the pilot converts before he writes a follow-on check.',
  avoid: 'Slides. Asking for the intro twice.',
  last_contact_at: daysAgo(23),
})
Facts.add({ person_id: marcus.id, text: `Offered on ${dateStr(daysAgo(23))} to introduce Dylan to Sarah Kwan at Ridge Capital. It has not happened.`, source: 'conversation', evidence: 'said "I\'ll connect you with Sarah at Ridge, she\'d like this"', confidence: 0.9 })

const tom = People.create({
  name: 'Tom Achebe',
  emails: ['tom@example.com'],
  role: 'Co-founder, engineering',
  relationship: 'Co-founder',
  summary: 'Runs standup. Carrying the data pipeline alone right now. Says less than he means.',
  wants: 'No new scope before the pilot readout. A second engineer.',
  avoid: 'Adding features in standup.',
  last_contact_at: daysAgo(1),
})
Facts.add({ person_id: tom.id, text: `Mentioned not sleeping well on ${dateStr(daysAgo(8))} and again on ${dateStr(daysAgo(2))}.`, source: 'conversation', evidence: '"not sleeping great" on two separate calls', confidence: 0.85 })

const elena = People.create({
  name: 'Elena Marsh',
  emails: ['elena.marsh@example.com'],
  relationship: 'Friend from college, lives in Chicago',
  summary: 'Oldest friend. Just changed jobs. You said you would call and have not.',
  wants: 'A real catch-up, not a text.',
  last_contact_at: daysAgo(14),
})
Facts.add({ person_id: elena.id, text: 'Birthday is September 9.', source: 'you', confidence: 1 })

const jonah = People.create({
  name: 'Jonah Reyes',
  emails: ['jonah@fieldstonesearch.example'],
  role: 'Recruiter',
  company: 'Fieldstone Search',
  relationship: 'Cold outreach, unanswered',
  summary: `Reached out on ${dateStr(daysAgo(4))} about a Head of Product role at a Series B. Unanswered. Might be useful for Tom's hiring instead.`,
  last_contact_at: daysAgo(4),
})

const sarah = People.create({ name: 'Sarah Kwan', role: 'Partner', company: 'Ridge Capital', relationship: 'Never met; the intro Marcus offered' })

const devin = People.create({ name: 'Devin Okafor', emails: ['devin.okafor@latticehealth.example'], role: 'Analyst', company: 'Lattice Health', relationship: 'Works for Priya; joins the pilot check-ins', summary: 'Quiet in meetings, sends good questions afterwards by email.' })

const events = [
  { id: 'demo-standup', title: 'Standup', start: at(0, 10, 0), end: at(0, 10, 30), attendees: [{ name: 'Tom Achebe', email: 'tom@example.com' }] },
  { id: 'demo-priya', title: 'Pilot check-in', start: at(0, 14, 0), end: at(0, 14, 45), attendees: [{ name: 'Priya Natarajan', email: 'priya.natarajan@latticehealth.example' }, { name: 'Devin Okafor', email: 'devin.okafor@latticehealth.example' }], description: 'Monthly pilot check-in. Agenda: retention, rollout to the second clinic, decision timeline.' },
  { id: 'demo-marcus', title: 'Coffee with Marcus', start: at(1, 11, 0), end: at(1, 11, 30), attendees: [{ name: 'Marcus Bell', email: 'marcus@bellventures.example' }], location: 'Saint Frank, Polk St' },
  { id: 'demo-pipeline', title: 'Pipeline review', start: at(2, 16, 0), end: at(2, 17, 0), attendees: [{ name: 'Tom Achebe', email: 'tom@example.com' }] },
]
fs.writeFileSync(LOCAL_CALENDAR_PATH, JSON.stringify(events, null, 2) + '\n')
for (const e of events) {
  Events.upsert({
    source: 'local',
    uid: e.id,
    title: e.title,
    description: e.description ?? null,
    location: e.location ?? null,
    start: e.start,
    end: e.end,
    all_day: 0,
    attendees: e.attendees.map((a) => ({ ...a, person_id: People.ensureFromAttendee(a).id })),
  })
}
const priyaEvent = Events.between(new Date(at(0, 13)), new Date(at(0, 15)))[0]
const marcusEvent = Events.between(new Date(at(1, 10)), new Date(at(1, 12)))[0]

Commitments.add({ text: 'Send Priya the retention numbers before the pilot check-in', owner: 'me', person_id: priya.id, due: at(0, 13, 30) })
Commitments.add({ text: 'Call Elena', owner: 'me', person_id: elena.id, due: daysAgo(7) })
Commitments.add({ text: 'Intro to Sarah Kwan at Ridge Capital', owner: 'them', person_id: marcus.id })
Commitments.add({ text: 'Reply to Jonah Reyes either way', owner: 'me', person_id: jonah.id })

Observations.add({
  kind: 'risk',
  text: `Both times the Priya check-in moved, you moved it the day before. If today's slips too, she will read it as the pilot slipping, and she has a board asking about it monthly.`,
  evidence: [`${dateStr(daysAgo(13))} check-in moved on ${dateStr(daysAgo(14))}`, `${dateStr(daysAgo(6))} check-in moved on ${dateStr(daysAgo(7))}`, 'Priya: the board asks about retention every month'],
  confidence: 0.8,
  surface_when: 'before_event',
  event_id: priyaEvent?.id ?? null,
  person_id: priya.id,
  expires_at: at(0, 15),
})
Observations.add({
  kind: 'followup',
  text: `Marcus offered the Sarah Kwan intro on ${dateStr(daysAgo(23))} and it has not happened. Tomorrow's coffee is the place to ask once, lightly, and not again.`,
  evidence: [`Marcus, ${dateStr(daysAgo(23))}: "I'll connect you with Sarah at Ridge"`, 'Marcus: avoid asking for the intro twice'],
  confidence: 0.75,
  surface_when: 'before_event',
  event_id: marcusEvent?.id ?? null,
  person_id: marcus.id,
  expires_at: at(1, 12),
})
Observations.add({
  kind: 'social',
  text: `Elena's birthday is the 9th and you have owed her a call since ${dateStr(daysAgo(14))}. Tomorrow after Marcus, the afternoon is open.`,
  evidence: ['Elena: birthday September 9', `Commitment "Call Elena", due ${dateStr(daysAgo(7))}, past due`, 'Tomorrow: nothing after 11:30'],
  confidence: 0.7,
  surface_when: 'next_checkin',
  event_id: null,
  person_id: elena.id,
  expires_at: at(3, 0),
})
Observations.add({
  kind: 'pattern',
  text: `Tom has mentioned not sleeping twice in eight days, and the pipeline review is the day after tomorrow. That review is where he will either ask for help or not.`,
  evidence: [`Tom, ${dateStr(daysAgo(8))} and ${dateStr(daysAgo(2))}: "not sleeping great"`, 'Tom wants a second engineer', 'Pipeline review in two days'],
  confidence: 0.65,
  surface_when: 'next_checkin',
  event_id: null,
  person_id: tom.id,
  expires_at: at(3, 0),
})

KV.set('onboarded', '1')
console.log(`Demo profile seeded in ${DATA_DIR}\n${People.all().length} people, ${events.length} events, ${Commitments.open().length} open commitments, ${Observations.queued().length} queued observations.\nStart it with: npm run demo:start   (port 4748)`)
