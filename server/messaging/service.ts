import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { IncomingMessage, Turn, Workflow } from './workflow.js'

const Incoming = z.object({
  externalId: z.string().trim().min(1).max(200),
  sender: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1).max(8000),
}).strict()

interface EventRow {
  id: number
  conversation_id: string
  text: string
  state: 'queued' | 'processing' | 'completed' | 'failed'
  reply: string | null
}

/** Local simulator storage. Sender labels are NOT verified phone identities. */
export class MessagingService {
  private readonly db: DatabaseSync
  private draining = false

  constructor(filename: string, private readonly workflow: Workflow) {
    this.db = new DatabaseSync(filename)
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, sender TEXT NOT NULL, workflow TEXT NOT NULL,
        UNIQUE(sender, workflow)
      );
      CREATE TABLE IF NOT EXISTS inbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        external_id TEXT NOT NULL UNIQUE,
        conversation_id TEXT NOT NULL,
        text TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued',
        reply TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `)
  }

  receive(input: IncomingMessage) {
    const message = Incoming.parse(input)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const previous = this.db.prepare(`SELECT inbox.*, conversations.sender, conversations.workflow
        FROM inbox JOIN conversations ON conversations.id = inbox.conversation_id
        WHERE external_id = ?`).get(message.externalId) as (EventRow & { sender: string; workflow: string }) | undefined
      if (previous) {
        if (previous.sender !== message.sender || previous.text !== message.text || previous.workflow !== this.workflow.id) {
          throw new Error('Message ID already belongs to a different payload or workflow.')
        }
        this.db.exec('COMMIT')
        return { id: previous.id, duplicate: true }
      }
      this.db.prepare('INSERT OR IGNORE INTO conversations (id, sender, workflow) VALUES (?, ?, ?)')
        .run(randomUUID(), message.sender, this.workflow.id)
      const conversation = this.db.prepare('SELECT id FROM conversations WHERE sender = ? AND workflow = ?')
        .get(message.sender, this.workflow.id) as { id: string }
      const row = this.db.prepare('INSERT INTO inbox (external_id, conversation_id, text) VALUES (?, ?, ?)')
        .run(message.externalId, conversation.id, message.text)
      this.db.exec('COMMIT')
      return { id: Number(row.lastInsertRowid), duplicate: false }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** One ordered worker. Failed/uncertain turns block later turns in that conversation. */
  async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (true) {
        const next = this.db.prepare(`UPDATE inbox SET state = 'processing' WHERE id = (
          SELECT i.id FROM inbox i JOIN conversations c ON c.id = i.conversation_id
          WHERE i.state = 'queued' AND c.workflow = ? AND NOT EXISTS (
            SELECT 1 FROM inbox earlier WHERE earlier.conversation_id = i.conversation_id
            AND earlier.id < i.id AND earlier.state != 'completed'
          ) ORDER BY i.id LIMIT 1
        ) AND state = 'queued' RETURNING *`).get(this.workflow.id) as unknown as EventRow | undefined
        if (!next) break
        try {
          const rows = this.db.prepare(`SELECT text, reply FROM (
            SELECT id, text, reply FROM inbox WHERE conversation_id = ? AND id < ?
            AND state = 'completed' ORDER BY id DESC LIMIT 30
          ) ORDER BY id`).all(next.conversation_id, next.id) as unknown as { text: string; reply: string }[]
          const history: Turn[] = rows.flatMap(row => [
            { role: 'user' as const, text: row.text },
            { role: 'assistant' as const, text: row.reply },
          ])
          const reply = await this.workflow.handle({ history, message: next.text })
          if (typeof reply !== 'string' || !reply.trim()) throw new Error('Workflow returned no reply.')
          this.db.prepare("UPDATE inbox SET state = 'completed', reply = ? WHERE id = ?").run(reply, next.id)
        } catch {
          // Do not turn failure into success or replay potentially consequential work automatically.
          this.db.prepare("UPDATE inbox SET state = 'failed' WHERE id = ?").run(next.id)
        }
      }
    } finally {
      this.draining = false
    }
  }

  result(id: number): EventRow | undefined {
    return this.db.prepare(`SELECT inbox.* FROM inbox JOIN conversations c ON c.id = inbox.conversation_id
      WHERE inbox.id = ? AND c.workflow = ?`).get(id, this.workflow.id) as unknown as EventRow | undefined
  }

  close(): void { this.db.close() }
}
