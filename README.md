# swefall2026
Nueva CS350 SWE - fall2026

# Wren

An assistant that meets with you a few times a day, thinks about your next two days while you're away, and talks.

It is not a chat window. Wren schedules conversations with you (a morning check-in, a brief fifteen minutes before each meeting, an evening debrief), prepares each one ahead of time, pings your Mac when it's time, and speaks its opening line the moment you join. Between conversations it reads your calendar and its own memory and writes down only the things it can point to: a meeting you've moved three times, a promise drifting past its date, a person who wants something you're about to walk past.

The brain is Claude (`claude-opus-5` by default). The voice is ElevenLabs when you have a key, OpenAI's TTS as a second choice, and the Mac's own voice so it always works. Hearing is ElevenLabs Scribe, OpenAI, or the browser's own recognition, in that order.

## What it does

**Scheduled conversations.** Set in Settings. Defaults: morning check-in at 8:30 on weekdays, evening debrief at 6:30 every day, a pre-meeting brief 15 minutes before any calendar event with other people on it. Each one is prepared about 45 minutes ahead: Wren thinks through what matters, writes the points and the evidence behind them, briefs you on the people, and pre-renders its opening line so it starts speaking on time.

**Dead-time thinking.** Every twenty minutes (when something has changed, never during quiet hours, within a daily budget) Wren reads the next two days and decides whether anything is worth saying. Usually nothing is, and it writes nothing. When it does write an observation it must name a specific person, event, or date and quote its evidence. Observations wait for the right moment: the next check-in, right before a specific meeting, or, rarely, now, in which case Wren asks for a word (at most twice a day).

**Memory.** People, facts with their sources, promises in both directions, what Wren has noticed and whether it turned out to be right, and a profile of you that Wren appends to as it learns. All of it is visible and editable in the console. Every conversation is folded into memory when it ends.

**Doing things.** In conversation Wren can look people up, remember what you tell it, read and write your local calendar, log and close promises, schedule a follow-up conversation or reminder, open a draft in Mail for you to send, and, if you allow it, search the web about people before meetings.

**Reaching you.** A macOS notification when a conversation starts. If the console isn't open, Wren speaks through the Mac's speakers. If it is open, it speaks there.

## Setup

```bash
cd "$HOME/SWE class/swefall2026"
cp .env.example .env    # add ANTHROPIC_API_KEY, and ELEVENLABS_API_KEY if you have one
npm run build
npm start               # http://localhost:4747
```

On first run with a key, Wren schedules a "First conversation" a minute out and asks you about your work, the people who matter this month, and how you like to be talked to. Everything it learns goes into `data/about-me.md`, which you can edit any time.

**Calendar.** Put one or more ICS feed URLs in `.env` as `WREN_ICS_URLS` (Google Calendar: Settings, your calendar, "Secret address in iCal format"), or paste them in Settings. Add your own email addresses in Settings so you're left out of attendee lists. Events Wren creates for you go to `data/calendar.json`; it never writes to Google.

**Keep it running.** `scripts/install-launchd.sh` registers Wren as a launch agent that starts at login and restarts if it dies. Log at `data/wren.log`. `scripts/uninstall-launchd.sh` removes it.

**Development.** `npm run dev` runs the server with reload and the Vite console at http://localhost:5173.

## The demo profile

To see the console populated before connecting your own life:

```bash
npm run demo          # seeds data/demo with invented people, meetings, promises, observations
npm run demo:start    # http://localhost:4748
```

Nothing in the demo is real. It runs without a brain unless you add a key, so conversations answer with a placeholder; everything else (scheduling, preparing, voice, notifications, memory) behaves exactly as it does for real.

## Talking to it

Open the console. The home screen is the conversation: Wren's status is the headline, and the mic is the only control that matters. Hold it, or hold Space, and talk; let go to send. Or type; Enter sends. If nothing is scheduled, talking opens a conversation on the spot. Wren speaks its replies. End a conversation when you're done and Wren updates memory from what was said. Conversations you don't join are marked missed after three hours, and the evening debrief knows.

Everything else is one click away: Schedule (today, tomorrow, what Wren said today), People, Memory, Settings. Before a meeting, the prepared notes sit beside the transcript.

## Cost

Wren records every model call with its cost. The daily budget (default $5) stops dead-time thinking and preparation when it's spent; a live conversation may run to twice the budget so it never dies mid-sentence. The persona and your profile are cached across calls, and each conversation's world context is fixed when it starts so the cached prefix survives every turn.

## Layout

```
server/           the daemon (Node 22, Hono, node:sqlite)
  scheduler.ts    the clock: creates, prepares, fires, and closes conversations; runs dead-time thinking
  brain/          prepare (before), converse (during), extract (after), reflect (between), tools (doing)
  prompts.ts      who Wren is and how it speaks
  context.ts      everything Wren is allowed to know right now, as data
  llm.ts          Claude calls, budget, cost
  calendar.ts     ICS feeds + local calendar -> events -> people
  voice/          ElevenLabs / OpenAI / Mac for speaking; ElevenLabs / OpenAI for hearing
web/              the console (Vite, React, Tailwind v4, Motion)
shared/types.ts   the contract between the two
data/             your database, audio cache, profile, local calendar, config (gitignored)
```

Config lives in `data/wren.config.json` and is editable from Settings. Keys live only in `.env`.
