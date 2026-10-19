> Historical reference. The current plan is in [the build spec](../MVP_BUILD_SPEC.md); current status is in [README](../../README.md).

# Start production: Daymark

Read `PRODUCT_SPEC.md` and `docs/MVP_BUILD_SPEC.md` in `/Users/dylanszeto/SWE class/swefall2026`, then implement the new MVP in this repository.

Daymark replaces Homeline's product direction. It is an iPhone-first agent for parents managing multiple school-age children. It prepares work autonomously, presents the real deliverable for approval, executes the approved action, and records evidence of the result.

Build three workflows: school notices to calendar changes; pickup requests to caregiver acceptance; school requests to drafted and sent emails. The main interface is one request composer and a small review queue, with a secondary Plan view. No generic advice, mandatory meetings, dashboard clutter, purchases, or unrestricted browser automation.

First prove authentication, native sign-in return, isolated Convex state, and the required Composio scopes. Then build an end-to-end calendar flow with persistent jobs, versioned approvals, real provider execution, and receipts. Complete email sending and caregiver coordination next, followed by intake and physical-device verification. Preserve the distinction between prepared, sent, accepted, and physically completed.

Keep React/TypeScript/Vite/Capacitor and useful shared validation. **Version 2 selects Convex for the new backend and durable workflows**, replacing the previously planned PostgreSQL queue. Retain Hono/SQLite only as the legacy prototype and migration source. Use Auth0 for identity, Composio behind restricted Gmail/Calendar wrappers, and Vercel for previews and caregiver response pages. Daytona is optional isolated browser-test infrastructure, not an always-on family agent or an iOS build machine. Keep tool adapters independent of the interface so messaging channels can be added later.

Follow the build–test–fix process inspired by [Riley Brown's post](https://x.com/rileybrown/status/2102252318448058464). Read `docs/RILEY_WORKFLOW_RESEARCH.md` for verified observations and our own decisions. Implement one complete outcome, exercise it through the UI, inspect the real result, fix defects, rerun, and retain evidence before expanding scope. Use Vitest/convex-test, Playwright preview checks, bounded model evaluations, and a separate macOS/Xcode native test lane. Pair each Vercel preview with an isolated Convex backend and synthetic fixtures.

Important existing conditions:

- The repository has substantial uncommitted work. Inspect it and preserve it; do not reset or discard files.
- Current iOS data and browser/server data are separate. Preserve their storage identifiers and make any import explicit.
- The existing model extraction is not verified with live credentials; native mode currently uses guided entry.
- Existing messaging code is a local simulator, not a production iMessage/WhatsApp integration.
- Full Xcode/native device verification was unavailable in the previous setup. Check the current environment before claiming native success.
- The new name has been applied to the planning documents. Update visible app branding during implementation while preserving bundle/storage identity.
- New infrastructure is specified, not provisioned. Confirm available service credentials and Apple setup without printing secrets. Never substitute production-looking mocks for an unavailable integration.

Each checkpoint must return a short evidence packet: commit/build identity, preview link, relevant test results, screen recording or failure trace, actual test-provider receipt, native verification status, and remaining blockers. Do not claim iPhone verification from a phone-sized browser screenshot.

The build spec contains scope, interaction rules, tool contracts, state transitions, migration requirements, tests, and source links. Do not expand the first release into a general assistant. Do not treat mocks as real completed work.
