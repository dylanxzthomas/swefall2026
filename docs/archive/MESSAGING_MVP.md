> Historical reference. The current plan is in [the build spec](../MVP_BUILD_SPEC.md); current status is in [README](../../README.md).

# Wren messaging MVP scaffold

Build one useful recurring workflow delivered through a contact in Messages. The target user, exact outcome, and tools are still undecided. The existing web assistant is an earlier prototype, not the scope of this new product.

## Working now

- A local CLI simulates incoming texts without a provider account or API key.
- SQLite stores conversations, incoming messages, processing state, and replies across restarts.
- Repeated message IDs return the existing result instead of running the workflow again. Reusing an ID with different content is rejected.
- Conversations are separated by sender and workflow. A workflow receives its latest 30 completed exchanges.
- An ordered worker processes queued messages. A failed or interrupted message blocks later messages in that conversation, without blocking other senders.
- The only workflow is explicitly unconfigured. It returns a connection-test response and has no tools or model access.

```bash
npm run messaging:simulate -- --from me --id first-message --text "Hello Wren"
npm run test:messaging
```

Run the same simulation twice to check duplicate handling. Responses print locally; nothing is sent to a phone. Data lives in the gitignored `data/messaging-simulator.sqlite` database.

## Boundaries

`server/messaging/workflow.ts`: the input and conversation contract, plus the unconfigured workflow.

`server/messaging/service.ts`: persistent intake, deduplication, ordered processing, and history.

`server/messaging/simulate.ts`: local channel adapter. Sender labels are for testing, not authenticated users.

The new workflow deliberately does not call the old general-purpose tool runner or read its global personal memory. When scope is chosen, give the workflow only the capabilities it needs through explicit dependencies. Do not add an unrestricted fallback agent.

## Decide before connecting a real number

1. Who is the first user, and what single recurring problem does Wren solve?
2. What starts the workflow, what information does it need, and what counts as completion?
3. What may Wren do itself, and which actions require a reply approving them?
4. Which integrations are essential for that one outcome?
5. When may Wren initiate contact, and how does the user pause it?

## Next implementation steps

- Implement the selected workflow and its narrowly scoped tools.
- Choose an iMessage/SMS provider; verify number ownership, call forwarding, and provider terms.
- Add authenticated webhooks and map verified senders to accounts. Names and phone numbers supplied in a request are not authentication.
- Add an outbound queue with delivery receipts and provider idempotency. A generated reply is not a delivered message.
- Add explicit recovery for failed or interrupted work. Never replay external actions blindly after a crash.
- Add scheduled outreach with consent and quiet hours.
- Add live phone audio, interruption handling, and the same account context for calls and texts.
- Deploy the channel service with account isolation and protected setup endpoints. Do not expose the existing unauthenticated desktop API to the internet.

This is a single-machine development scaffold. It is not connected to iMessage, SMS, or a phone provider, and it is not a production multi-user service. There is no automatic retry of failed or interrupted work yet.
