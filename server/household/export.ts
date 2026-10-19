import { DatabaseSync } from 'node:sqlite'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
// Read-only export. No schema migration, configuration loading, or live service calls.
const source = process.argv[2], destination = process.argv[3]
if (!source || !destination || resolve(source) === resolve(destination)) throw new Error('Usage: npm run legacy:export -- path/to/household.sqlite path/to/export.json')
const db = new DatabaseSync(resolve(source), { readOnly: true })
try {
  const row = db.prepare('SELECT value FROM household WHERE id=1').get() as { value: string } | undefined
  if (!row) throw new Error('No household found in the legacy database.')
  writeFileSync(resolve(destination), row.value, { flag: 'wx', mode: 0o600 })
  process.stdout.write('Legacy export saved. Original database unchanged. Import only after signing in and reviewing the import action.\n')
} finally { db.close() }
