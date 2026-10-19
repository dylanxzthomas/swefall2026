/** Channel adapters normalize input; workflows own product behavior. */
export interface IncomingMessage {
  externalId: string
  sender: string
  text: string
}

export interface Turn {
  role: 'user' | 'assistant'
  text: string
}

export interface Workflow {
  id: string
  /** One sentence stating the single outcome this workflow supports. */
  purpose: string
  handle(context: { history: readonly Turn[]; message: string }): Promise<string>
}

/** No model or tools until the initial product scope is chosen. */
export const unconfiguredWorkflow: Workflow = {
  id: 'unconfigured',
  purpose: 'Local transport testing only; product workflow has not been selected.',
  async handle() {
    return 'Wren’s messaging connection is working locally. Its first workflow is not configured yet; no action was taken.'
  },
}
