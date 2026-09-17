import fs from 'node:fs'
import { PROFILE_PATH, getConfig } from './config.js'

export function profileTemplate(userName: string, assistantName: string): string {
  return `# About ${userName}

${assistantName} reads this before every conversation. Write it the way you'd brief a new chief of staff: plainly, with names. Edit it whenever you like; ${assistantName} also adds lines here as it learns things.

## Work
What I do, what I'm building, what this month is about.

## People who matter right now
Name, who they are to me, what's open between us.

## What a good week looks like

## Things I keep putting off

## How I like to be talked to
`
}

export function readProfile(): string {
  const cfg = getConfig()
  if (!fs.existsSync(PROFILE_PATH)) {
    fs.writeFileSync(PROFILE_PATH, profileTemplate(cfg.user.name, cfg.assistant.name))
  }
  return fs.readFileSync(PROFILE_PATH, 'utf8')
}

export function writeProfile(text: string): void {
  fs.writeFileSync(PROFILE_PATH, text.endsWith('\n') ? text : text + '\n')
}

/** Append a line under a `## Section` heading, creating the heading if it is missing. */
export function appendToProfile(section: string, line: string): void {
  const text = readProfile()
  const heading = `## ${section.trim()}`
  const clean = line.trim().replace(/^[-*]\s*/, '')
  const lines = text.split('\n')
  const idx = lines.findIndex((l) => l.trim().toLowerCase() === heading.toLowerCase())
  if (idx === -1) {
    writeProfile(`${text.trimEnd()}\n\n${heading}\n- ${clean}\n`)
    return
  }
  let end = idx + 1
  while (end < lines.length && !lines[end].startsWith('## ')) end++
  // drop the template hint line if it's still there and unedited
  const block = lines.slice(idx + 1, end)
  const filtered = block.filter((l) => !/^(What I do, what I'm building|Name, who they are to me)/.test(l.trim()))
  const newBlock = [...filtered.filter((l, i) => !(i === filtered.length - 1 && l.trim() === '')), `- ${clean}`, '']
  lines.splice(idx + 1, end - idx - 1, ...newBlock)
  writeProfile(lines.join('\n'))
}
