import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import path from 'node:path'
import { DATA_DIR } from '../config.js'
import { MessagingService } from './service.js'
import { unconfiguredWorkflow } from './workflow.js'

const { values } = parseArgs({ options: {
  from: { type: 'string', default: 'local-owner' },
  text: { type: 'string' },
  id: { type: 'string' },
}, strict: true })

if (!values.text) {
  console.error('Usage: npm run messaging:simulate -- --text "Hello" [--from local-owner] [--id unique-message-id]')
  process.exitCode = 1
} else {
  const service = new MessagingService(path.join(DATA_DIR, 'messaging-simulator.sqlite'), unconfiguredWorkflow)
  try {
    const received = service.receive({ sender: values.from!, text: values.text, externalId: values.id ?? randomUUID() })
    await service.drain()
    console.log(JSON.stringify({ channel: 'local-simulator', workflow: unconfiguredWorkflow.id, ...received, result: service.result(received.id) }, null, 2))
  } finally {
    service.close()
  }
}
