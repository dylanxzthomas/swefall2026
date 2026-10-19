> Historical reference. The current plan is in [the build spec](../MVP_BUILD_SPEC.md); current status is in [README](../../README.md).

# Riley Brown reference → Daymark decisions

Reviewed September 28, 2026. This is the rationale for build-spec version 2, not a claim that the new infrastructure is deployed.

## What the post actually establishes

[Riley's September 21 post](https://x.com/rileybrown/status/2102252318448058464) names Vercel, Daytona, Convex, and Composio as building blocks for a personal-agent platform. He describes using Astra through Codex and says Codex is testing during development, around twenty minutes into his build.

The short video shows a phone-shaped interface moving between conversation, an artifacts view, and settings with connected services. I inspected those views through the browser. The post does not disclose the complete architecture, test assertions, CI setup, native build process, or production reliability. It does not establish that every displayed connection is working.

**Our inference:** the transferable approach is managed infrastructure plus a coding agent that repeatedly exercises the interface and fixes what it finds. We should emulate that process and produce stronger evidence for our three narrow workflows. We should not promise a complete production app in twenty minutes.

## The tools and our choices

| Tool Riley names | Verified capability | Daymark decision |
|---|---|---|
| Vercel | Frontend hosting and preview deployments for changes | Host React/Vite browser previews, caregiver response pages, and public links; distribute the iPhone binary separately |
| Convex | Reactive backend data and durable workflow components | Own household state, jobs, versioned approvals, receipts, subscriptions, and scheduled follow-through; replace the planned custom PostgreSQL queue |
| Composio | Per-user connected accounts, authentication, and tool execution | Connect Gmail/Calendar behind narrow server wrappers; allow only the actions in our spec |
| Daytona | Sandboxed compute and computer-use/browser capabilities | Optional isolated browser-test runner with synthetic data; no always-running per-family computer or unrestricted runtime browsing in MVP |
| Codex/Astra | Riley attributes development and testing to this combination | Use the available coding agent to implement, inspect, test, and repair each complete workflow; do not hard-code a development model name into the consumer app |

Sources: [Vercel deployment environments](https://vercel.com/docs/deployments/environments), [Convex workflows](https://docs.convex.dev/agents/workflows), [Convex Workflow component](https://www.convex.dev/components/workflow), [Composio sessions](https://docs.composio.dev/reference/v3/api-reference/tool-router), [Daytona computer use](https://www.daytona.io/docs/en/computer-use/).

## Two separate agent loops

**Building the product:** implement a small outcome → run it through the UI → inspect the backend/provider result → fix → rerun the relevant scenario → retain evidence.

**Using the product:** receive a parent request → prepare a specific deliverable → obtain approval → execute only that revision → verify and report the result.

Codex is our development assistant. Daymark is the consumer agent. They must not share credentials or unrestricted authority merely because both use tools.

## What changes in the MVP

- Build one complete school-notice workflow before assembling a large collection of screens.
- Put the useful artifact directly in the conversation: an editable calendar change, email, or caregiver request. Long conversational answers are secondary.
- Keep memory and connections behind settings. Do not copy the demo's broad app catalog, model selector, or generic artifact gallery into a parent product.
- Make state reactive so parents immediately see a draft, approval, response, or receipt without refreshing.
- Use durable jobs that wait for a decision without keeping a phone, HTTP request, or sandbox running.
- Make the coding agent show its work: screen evidence, relevant automated checks, actual provider result, and remaining limitations.
- Test repeatable scenarios automatically, alongside open-ended agent inspection. A demo of clicking through screens is not a regression suite.

## Specific launch and testing decisions

- Pair each Vercel preview with a separate Convex preview backend and synthetic household; a preview URL alone does not isolate data. [Convex multiple deployments](https://docs.convex.dev/production/multiple-deployments)
- Use Vitest plus `convex-test` for permissions, approvals, and state transitions; it is a mock backend, so also test real service behavior in staging. [Convex testing](https://docs.convex.dev/testing/convex-test)
- Use Playwright for browser regression tests and retain traces on failure. Use accessible selectors and observed state, not fixed sleeps or fragile coordinates. [Playwright best practices](https://playwright.dev/docs/best-practices), [trace viewer](https://playwright.dev/docs/trace-viewer)
- Use a macOS/Xcode lane for the actual iPhone app. Prove Maestro can drive the app's WebView and key native surfaces before adopting it; use XCUITest where native coverage is needed. Maestro documents iOS simulator support; a Daytona browser sandbox is not a substitute for an iOS simulator. [Maestro iOS](https://docs.maestro.dev/get-started/supported-platform/ios)
- Internal device testing precedes external parent testing. TestFlight distribution requires Apple setup and external builds may need beta review. [Apple TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)

## What four API keys do not solve

- Household identity and authorization: the spec selects Auth0, with a native sign-in proof before broad UI work. Convex documents third-party auth integrations separately from its backend; its own auth offering is marked beta. [Convex authentication](https://docs.convex.dev/auth/overview), [Convex/Auth0](https://docs.convex.dev/auth/auth0)
- OAuth permissions: inspect and minimize the actual scopes requested by Composio. Use a custom auth configuration for production control; do not assume a toolkit's default scopes match our send-only requirement. A scoped wrapper limits execution but does not reduce the provider's granted OAuth access. [Composio scope controls](https://docs.composio.dev/docs/authentication/controlling-scopes), [custom auth](https://docs.composio.dev/docs/auth-configuration/custom-auth-configs)
- Reliable external writes: database/workflow retries do not prove an email was sent exactly once. Keep uncertain sends unresolved until reconciled; never replay the entire package blindly.
- Model access, transactional/inbound email, push delivery, signing, privacy disclosures, and App Store review still need implementation and configuration.
- Cost: track model calls, workflow execution, provider operations, storage, and test-sandbox runtime per completed job. Stop idle test sandboxes and keep durable results outside them. [Daytona persistence and lifecycle](https://www.daytona.io/docs/en/persistence/)

## Assessment

Yes: the architecture and build–test–fix workflow are attainable for this MVP. The stack reduces infrastructure work. Whether parents receive correct, useful outcomes still depends on our domain rules, limited tool access, real integration testing, and observed time saved. The revised spec makes those the release criteria.
