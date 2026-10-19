> Historical reference. The current plan is in [the build spec](../MVP_BUILD_SPEC.md); current status is in [README](../../README.md).

# Daymark — product overview

**Daymark handles school and activity admin for parents: it prepares the work, asks for approval, carries out supported actions, and confirms the result.**

Target user: parents managing two or more elementary- or middle-school children, especially those coordinating several schools, activities, and caregivers.

## First three features

- **School updates → calendar changes.** Share a notice, screenshot, PDF, or forwarded email. Daymark prepares the events and deadlines, identifies changes and duplicates, and updates the connected calendar after approval.
- **Pickup request → confirmed responsibility.** Daymark drafts and sends an approved caregiver request, collects an explicit answer, and updates the arrangement. Declines or proposed changes return to the parent with the next decision ready.
- **School request → sent reply.** Daymark writes the actual RSVP, attendance notice, or clarification email. The parent reviews it; Daymark sends it from their connected account and records the result.

## Workflow

Share or ask → background preparation → review → approved execution → receipt.

The agent remembers confirmed household details and prepares work without requiring another explanation. Parents approve external changes and outgoing messages. Physical tasks, school acceptance, and caregiver commitments are never marked complete without the relevant evidence.

## Interface

- iPhone first, with two destinations: Assistant and Plan.
- One request field, attachments, and a small queue of finished work ready for review.
- Actual drafts and proposed changes appear before explanations.
- Optional notifications for decisions and failures; routine progress stays in the app.
- No mandatory check-ins, dashboard metrics, general advice feed, or separate shopping tab.

## MVP boundary

Start with Google Calendar, Gmail sending, and caregiver response links. Support manual sharing and forwarding before full inbox access. Defer purchases, bookings, portal submissions, automatic form signing, live calls, and messaging-platform integrations.

Success means less parent effort per completed job, reliable execution, and repeat use for real work. Willingness to pay remains to be tested.

## Build and test approach

- Keep the iPhone app in React/Capacitor. Use Convex for shared state and durable agent jobs, Composio for restricted integrations, and Vercel for browser previews and caregiver links.
- Build one complete outcome at a time. The coding agent exercises the interface, checks the actual result, fixes defects, and reruns the relevant tests.
- Use isolated preview data and repeatable browser tests; separately test the native app with Xcode and distribute parent pilots through TestFlight.
- Daytona is optional for disposable browser testing. The MVP does not require a permanent computer per household.
- Keep each deliverable inside its request thread, with one editable version and an explicit approval action.

## Implementation status

This is the **new build direction**, not a list of shipped capabilities. The existing app remains the Homeline organizer prototype until the production overhaul. Daymark is the new working product name; launch availability is not cleared.

- [Full build spec, design research, architecture, and acceptance criteria](../MVP_BUILD_SPEC.md)
- [Start here in the next production chat](PRODUCTION_HANDOFF.md)
- [Riley Brown workflow analysis and tool decisions](RILEY_WORKFLOW_RESEARCH.md)
- [Preserved Homeline prototype spec](HOMELINE_PROTOTYPE_SPEC.md)
