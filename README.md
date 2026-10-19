# Daymark

Daymark is an iPhone-first household assistant, with Sola helping parents keep track of family plans, responsibilities and correspondence. The first connected outcomes are calendar updates, caregiver arrangements and approved school replies.

## Current status

**The connected follow-through update is deployed; full MVP acceptance remains open.** Sola can fill missing details in the same unsent draft across successive replies, preserving earlier answers and returning the draft for review. Proactive Gmail preparation now uses current saved task/request status to distinguish completed obligations from genuinely new work. Recognized temporary coordinator model failures recover at most twice without replaying provider actions. Sola retains prepared-work turns and useful original parent context when an old answer becomes stale. Background mail checks no longer replace an unrelated conversation topic. The model can read current saved work and edit, finish, reopen or remove tasks; revise a draft; cancel pending work; or hide a request. The server checks identity, intent, ambiguity, versions and execution state. External effects still require exact approval and verification; hiding a request never undoes a sent email or calendar event.

**The interface is simpler.** A compact pinned header keeps Settings and History accessible while the conversation scrolls; opening Settings by direct tap preserves the reading position. Household settings use compact groups with details opened on demand. Voice appears inline in the main thread. Its first-use processing choice is remembered per adult/backend/mode on the device; later microphone taps start directly. OS microphone permission remains separate, and returning from the background never starts a call. The composer keeps typing focus through sending, grows for multiline input and avoids the bright pointer-focus outline. General voice captions remain temporary; this update does not add memory across voice calls.

**Verification:** 1,789 core checks/144 files, all 210 browser scenarios, three project type checks and 13 source/release/voice-lifecycle checks pass. Eight actual-model conversation/tool selections pass. A fresh real-model/Convex sequence fills start and end times through separate replies in the same calendar draft, retaining original content/evidence and creating no provider connections, approvals, dispatch attempts or receipts (eight model calls). Two actual-model cached-email cases suppress a completed form obligation and prepare a genuinely new later form; token-free synthetic mailbox records cannot access Gmail. Those isolated databases are removed after testing. The preceding UI release has 20 reviewed light/dark screenshot comparisons; this update changes backend behavior and leaves the interface bundle unchanged. Synthetic checks are not broad parent acceptance.

**Existing dedicated-account proofs:** actual Gmail cloud preparation, draft creation, same-ID editing and approved sending/Sent verification, including original-thread replies; Google Calendar creation/update, external-edit read-back and deletion; independent caregiver invitation/acceptance and its parent receipt. These prove only those synthetic actions, not pickup completion or unrestricted connector reliability. The owner confirms hosted and physical-iPhone live voice, native connected-session restart recovery, mute/unmute and background microphone shutdown on the preceding installed build. The new native App/Share build passes signing, profile/shared-container validation and release/backend pairing after owner Keychain approval. Wi-Fi installation and exact-device launch now pass after refreshing Xcode’s device service; the installed app retains its shared container. The owner confirms saved work remains and a second microphone tap starts voice directly inline without repeated approval. The owner also confirms synthetic task creation, rename and deletion on the updated iPhone. The latest pinned-header update is also signed, installed and launched over Wi-Fi, with owner-confirmed scrolling and Settings access. The typing/context check is explicitly postponed; these owner reports are not agent-observed audio. The installed native interface remains the preceding `dccdcf2e` build; no new physical acceptance is claimed for this backend-only update.

**Hosted pilot:** [sola-development.vercel.app](https://sola-development.vercel.app), Convex project **Sola**, deployment `mellow-reindeer-860`, source `e07bfe75aa29efbb7ab123098c240f030f334bf6c298d6ca4996dc8b8b683cc9`. Matched backend deployment, public source/backend/model pairing, four configured security headers, six unsigned private-query rejections and signed-in settings/loading checks pass. The earlier Convex Free-plan usage warning is not assumed resolved; no upgrade was purchased.

**Limits and next work:** automatic question continuation currently requires one unsent, text-sourced draft and its current question; question-only turns and private/provider-derived drafts still need explicit review. Broaden everyday follow-up/ambiguity/relevance, conversational outcome closure and two-adult acceptance, then integrated native Share/EventKit/provider execution and broader audio-route/expiry/revocation tests. The no-account workspace remains a separate local organizer without a general model; it does not acquire connected intelligence automatically. Composio, general shopping and website booking remain unconnected. The notice corpus still has one held-out location mismatch (59/60). Simulator overload and unavailable Device Hub mirroring on this phone prevent direct physical UI automation. See [build checkpoints](docs/MVP_BUILD_SPEC.md#build-checkpoints), [iPhone setup](docs/IPHONE.md) and [architecture progress](docs/diagrams/sola-architecture-progress.html).

**Source and releases:** [GitHub main](https://github.com/dylanxzthomas/swefall2026) holds the Sola implementation, synthetic tests, native source and current documentation. Credentials, local databases, account sessions and generated build/test output are excluded. A source push is separate from deploying the hosted pilot or installing an iPhone build; their verified versions and remaining acceptance are recorded above.

## Project guide

- [Build spec](docs/MVP_BUILD_SPEC.md): authoritative requirements, architecture, build order, and acceptance criteria.
- [Sola architecture](docs/MVP_BUILD_SPEC.md#sola-architecture): component responsibilities and workflow, with an [editable SVG](docs/diagrams/sola-architecture.svg) and [PNG diagram](docs/diagrams/sola-architecture.png).
- [Architecture progress](docs/diagrams/sola-architecture-progress.html): clickable component status and remaining work, with a [marked-up PNG](docs/diagrams/sola-architecture-progress.png) and [editable SVG](docs/diagrams/sola-architecture-progress.svg). The progress update records the deployed coordinator, private tasks, calendar assistance, curation, attachments and voice code separately from outstanding provider/native acceptance. It retains five checkpoints, dependencies and exit evidence.
- [Development rules](AGENTS.md), [changelog](CHANGELOG.md), and [iPhone setup](docs/IPHONE.md).
- [Archive](docs/archive/): historical references only.

## Run locally

Requires Node 22.17 or newer.

```sh
npm install
npm run dev:web
```

Open http://127.0.0.1:5173/. The preview binds this loopback address and refuses an occupied port. Keep using this address for your saved work; browser storage is separate for each origin. The no-account MVP remains available. Try “Add buy sunscreen tomorrow to my tasks”, “What needs my attention?”, “What are you handling?” or “What can you do?” These work without sign-in. Try “Every Sunday at 7pm, add packing school bags to my tasks” to review a recurring schedule. “Remember Maya goes to Oak School” opens a confirmation; select the supported detail type and edit before saving. Add children when needed in Household settings or from review. Submit an explicit notice, edit missing details, and save it to the device Plan. Files are kept locally for manual review; automatic image/PDF reading is not connected. Copying messages and downloading calendar files do not send or import them. Device preparation works while an already-loaded page is offline; a cold browser reload still needs the development server.

The local preview serves only browser source, dependencies and named public documentation. Backend settings, credentials, family-data folders and test/native artifacts are blocked, including encoded-path variants. Browser tests use a separate dependency cache so they cannot disrupt the open preview. The real HTTP regression uses synthetic canaries and body-free checks for actual private files.

Optional connected mode uploads sources only after sign-in and household confirmation. Live model conversation, preparation and automatic draft revisions require both model settings. Conversation is bounded to recent unexpired turns by the same adult, up to six private older excerpts, current saved work and a secret-free capability inventory. Model output can prepare reviewable work, never approve or execute it; older replies do not establish current completion. Both the original conversation and its generated reply expire after 30 days, while explicitly saved tasks and deliverables remain. Device-mode data stays local; there is no automatic migration into a connected household. Original sources and files expire after 30 days on the next storage access; pending scheduled text stays through its scheduled time plus 30 days, renewed for 30 days when prepared or cancelled. Personal tasks, explicitly kept Library media, saved deliverables, and plan entries remain until removed. Household settings explain device privacy and provide explicit deletion.

Copy `.env.example` to `.env.local` for public `VITE_*` client settings. Set server credentials in the matching Convex deployment, never in `VITE_*` variables. Run `npm run dev:backend` for the selected backend. For this existing anonymous deployment, the launcher reuses its pinned backend/database, binds ports to `127.0.0.1`, restricts configuration-file access and hides internal client logs. It refuses occupied ports, preserves the deployment selection and stops its watcher/backend together. Other deployment selections use the ordinary Convex CLI. The watcher installs the Workflow component and regenerates the checked-in Convex bindings. This workspace currently has an ignored `.env.local` pointing to an anonymous local backend at ports 3210/3211. Its browser Auth0 configuration now matches the real development SPA, with exact callback/logout/web-origin URLs for `http://127.0.0.1:5173`; the public issuer metadata and served client configuration were checked, and actual Auth0 sign-in is now verified. Browser recovery after a provider redirect uses the Auth0 session, with explicit sign-in continuation if cookies prevent silent restoration; tokens remain in memory. `CONVEX_AGENT_MODE=anonymous npm run dev:backend` resumes that local server without creating a cloud account. Configure separate production/native identity settings before release.

The step-by-step [Gmail pilot walkthrough](docs/MVP_BUILD_SPEC.md#gmail-pilot-setup-walkthrough) covers the first reading-only test. It needs no Xcode, hosted browser, calendar writes or caregiver sending service.

Required setup for connected workflows. Device-only drafts and plan saves need none of these service credentials; native Apple Calendar requires the iPhone permission below:

| Service | Exact configuration needed |
|---|---|
| Convex | Development project/deployment; client URL and HTTP site URL; server environment from `.env.example`. Separate deployment for each preview. |
| Auth0 | SPA/native clients, issuer and client IDs matched in Convex, OIDC ID tokens, exact browser/native callbacks, and rotating native refresh tokens. Account deletion additionally needs a server M2M client with only Management API `delete:users`, plus `DAYMARK_TEST_AUTH0_SUBJECTS` in development. |
| Google | OAuth web client ID/secret, Calendar and Gmail APIs enabled, dedicated consent-screen test users; redirect `<CONVEX_SITE_URL>/google/callback` (`http://127.0.0.1:3211/google/callback` for the current local backend, or `https://<deployment>.convex.site/google/callback` for cloud); Calendar app-created scope, incremental Gmail send scope, separate restricted `gmail.readonly` for private inbox assistance, and incremental `gmail.compose` for separately reviewed draft creation/updates and sending; assess Google verification requirements before a public pilot. |
| Microsoft | Entra app allowing personal and work/school accounts; `MICROSOFT_CLIENT_ID`, server-only `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT=common`; **Web** redirect `https://<deployment>.convex.site/microsoft/callback`. Delegated `User.Read`, `offline_access`, and incremental `Calendars.ReadWrite`/`Mail.Send`. Tenant administrators may restrict consent. Uses the writable default Outlook calendar. |
| Apple Calendar | Build the iPhone app, allow full Calendar access for read-back, then select a writable calendar in Household. iCloud must already be configured on that phone. No Apple calendar web API key is used. Cloud work stays queued until that same app installation opens with permission; reinstalling requires a fresh connection/review. |
| Token encryption | `PROVIDER_TOKEN_KEYS`: JSON map of key IDs to base64 32-byte AES keys; `PROVIDER_TOKEN_KEY_ID`: current ID. Legacy `GOOGLE_TOKEN_KEYS`/`GOOGLE_TOKEN_KEY_ID` still work. Preserve old key IDs and values when migrating or rotating. These keys also protect approved reminder links. Key IDs must use 1–64 letters, digits, underscores or hyphens. A new backend-only development key is configured locally; its roundtrip and owner-binding rejection were verified without exposing key material. Connection readiness requires a usable key, and development Google consent requires a configured test mailbox. |
| Model | Server-only `ANTHROPIC_API_KEY` and an explicitly selected `DAYMARK_MODEL`; live fixture evaluation remains required. |
| Caregiver email / forwarding | `RESEND_API_KEY`, verified `DAYMARK_EMAIL_FROM`, HTTPS `DAYMARK_WEB_URL`; verified `DAYMARK_INBOUND_DOMAIN` and `RESEND_WEBHOOK_SECRET` for the `email.received` webhook at `<CONVEX_SITE_URL>/inbound/resend`. Forward only from the verified sign-in email. Unknown/unauthenticated senders are quarantined. |
| Optional iPhone alerts | APNs P8 private key, key ID, team ID, and environment; signed push entitlement for the existing bundle ID. Opt-in and editable quiet hours are enforced server-side. |
| Test isolation | `DAYMARK_ENVIRONMENT=development`; explicit `DAYMARK_TEST_GOOGLE_EMAILS`, `DAYMARK_TEST_MICROSOFT_EMAILS`, and `DAYMARK_TEST_EMAIL_RECIPIENTS` allowlists. Non-production connections/sends reject accounts outside these lists. |
| Vercel | Link a Daymark project. Preview builds require a Convex **project preview deploy key**; the build creates a separate backend per Vercel URL, binds its HTTP/client URLs, and configures its trusted web origin. Set development defaults in Convex and register exact Auth0/Google/Microsoft callbacks for each deployment. Shared/production keys are rejected for previews. Manual client/backend pairing is verified for the hosted pilot; automatic per-preview backend provisioning and isolation have not been exercised on Vercel. |

Google connect explicitly creates a separate Daymark calendar. Microsoft connect reads its existing default calendar without creating one. Calendar and email choices are separate; connecting Outlook preserves existing Google choices. Approvals bind the exact provider, account, connection/selection versions, destination, and reviewed content. The native bridge keeps a protected operation journal and only reads after an ambiguous save; it does not replay the write. Outlook direct-send attachments must fit a 3.5 MB encoded request; larger requests stop for correction before dispatch. An ambiguous send is never automatically replayed. Calendar recovery is read-only until evidence permits another review. A Gmail-delivered caregiver link requires a verified sign-in matching the assigned caregiver email; legacy transactional delivery uses a separately emailed code. Both grant access only to that request. The Gmail invitation and optional single reminder require exact sender/recipient/content approval, durable dispatch and SENT read-back; a parent-visible link alone cannot verify a response. Existing users can choose an in-app inbox using their verified sign-in email; the request is bound to that account and reveals only assigned pickup details. A changed delivery choice requires another parent review before dispatch. In-app reminders stay in that inbox and do not also send email. Suggested changes require another parent approval.

Original sources/uploads expire after 30 days, with the scheduled-text exception above; explicitly kept Library copies and personal tasks stay until removed or the household is deleted. Interrupted uncommitted private copies become eligible for cleanup after 24 hours, on the next hourly sweep; pre-rollout unclassified storage is preserved. Deletion immediately blocks household access, removes local account authorization, schedules supported provider revocation and Auth0 identity deletion, and removes family records/private files in bounded batches. Failed identity deletion is retried hourly for up to seven days; a minimal pending-deletion record remains for follow-up. Previously sent messages/calendar events remain with their providers. Microsoft disconnect erases stored tokens and reports provider revocation as unconfirmed; removing Daymark consent in Microsoft account permissions is a separate user action. Provider backup/retention configuration and actual deletion across the dedicated accounts still require release verification. Household settings explain these data uses; the native privacy manifest declares collected categories. Development did not purchase services or change billing; the owner funded API testing directly.

## iPhone preview

**Resume here:** Full Xcode 27, iOS 27, Command Line Tools, Java and Maestro are installed. The signed App/Share extension build succeeds. Automated local notice → location correction → approval → saved receipt → relaunch persistence passes in both light and dark appearances on our isolated simulator. Actual typing and the keyboard’s Done button pass. Keyboard dismissal now restores the header and prior reading position with drafts retained. The isolated Keychain/App Group/PDF Share/EventKit boundary checks pass. Actual native callback/household loading and owner-reported physical voice/restart recovery now pass; integrated parent-app Share/EventKit and broader native acceptance remain open.

Riley's demo window appears to be **Device Hub in Xcode 27**; his exact automation driver is undisclosed. `npm run ios:preview` builds and opens the real app in its own retained simulator, preferring iPhone 17 Pro. `npm run ios:doctor` now passes. See [iPhone setup](docs/IPHONE.md) for automated tests and connected/native setup.

## Verification

```sh
npm run typecheck
npm run test:daymark
npm run test:e2e       # first run: npx playwright install chromium
npm run test:visual    # reviewed macOS/Chromium screenshot comparisons
npm run test:local-backend # requires the running anonymous local backend
npm run test:local-caregiver -- --run # actual local in-app arrangement; synthetic accounts only
npm run test:local-routines # real local timers; model must be disconnected
npm run test:household
npm run test:mobile
npm run build
npm run ios:sync
npm run test:ios-tools
node --test --test-concurrency=1 scripts/dev-server.test.mjs tests/integration/voiceLifecycle.test.mjs
npm run eval:conversation -- --check # synthetic references only; no model call
npm run eval:email -- --check # ten synthetic Gmail relevance references only
npm run ios:doctor
# After installing Xcode, building the simulator app, Java 17+, and Maestro:
npm run test:native
npm run test:native-boundaries -- --calendar-run # actual plugins; isolated synthetic calendar, no account
# Only with an explicitly selected model and server credentials:
npm run eval:model -- --live
npm run eval:conversation -- --live
npm run eval:email -- --live
npm run test:local-mail-routines # actual model/local backend; synthetic mail only
```

The local routine suite waits for the next minute boundary, using synthetic households and no live model/provider calls. It refuses a configured preparation model, checks task creation, missing-model handling, pause and isolation, then removes its saved routines. Synthetic tasks and occurrence records remain as test data; it does not erase existing household data.

The visual suite follows the real no-account homepage through conversation, Tasks, Library, review, correction, approval, reload, and Plan, with 20 light/dark screenshot comparisons at 390 × 844, including assistant personalization, expanded Household settings, and a mixed list of parent tasks, scheduled preparation, and reviewable work. Baselines retain native system fonts and are specific to macOS/Chromium. Run in the same environment; review screenshots before intentionally updating them with `npm run test:visual -- --update-snapshots`. Other operating systems need their own reviewed baselines. This local visual suite is separate from the Linux CI browser tests and does not claim native appearance verification.

Browser suites start their own test-mode server at `127.0.0.1:5174`; they never reuse the normal preview at 5173. Stop any unrelated process on 5174 before running them. No-account browser scenarios exercise the real `/` app and its IndexedDB workspace, including verification that no provider requests occur. Connected browser scenarios use the synthetic harness served only in development test mode at `/e2e.html`; it is excluded from production builds. The backend suite covers isolation, revision checks, duplicate prevention, durable preparation, interrupted dispatch, partial success, OAuth-state replay, token locking/encryption, caregiver verification/overlap, document limits, retention, and legacy import. Provider adapters are mocked in these tests; the separate local-runtime check uses the real Convex binary with synthetic identities and no provider calls. CI retains browser traces, builds the native app/Share extension, and runs a Maestro compatibility flow for local notice review, correction, approved plan save, and relaunch persistence in light and dark appearances on a newly created disposable simulator. The expanded native flow now passes locally in light and dark appearances, including exact notice text, actual keyboard Done, correction, save, receipt and restart persistence. No user simulator is erased. Neither CI lane has run remotely. Local Xcode prerequisites, asset sync and the signed App/Share-extension build pass. The post-keyboard header/reading-position correction also passes actual native checks; these checks do not establish connected-device acceptance.

The eight-scenario conversation corpus covers brief/stressed requests, corrections, missing capabilities and false completion. `eval:conversation -- --check` checks synthetic reference answers only; `--live` requires both model settings and saves responses for human tone review. Automatic checks cannot establish conversational quality. The ten-message email corpus checks relevance, hidden dates/deadlines, missing content, grounded evidence and false completion; its reference check does not evaluate a model. The fixed 60-notice corpus separates development and holdout examples. `eval:model` records field/unsupported-action failures, grounded evidence, latency and provider usage without executing actions. Its actual model run scores 59/60, with nonempty literal evidence in every draft; one held-out location mismatch remains unresolved. The final run used 215,077 input and 14,389 output tokens; median generation was 2.796 seconds and p95 3.371 seconds. Results are synthetic accuracy evidence, not proof of provider execution or parent satisfaction. Approved reviews record foreground review duration and correction counts; preparation records model usage and duration. Provider bills and parent observations are still needed to measure total cost and effort saved. Every build writes `web/dist/release.json` with the commit/dirty state, bundle fingerprint, backend, tool versions, and optional evaluated model. It explicitly leaves native verification unclaimed.

## Preserved organizer data

The earlier interface remains in `web/src/LegacyApp.tsx`, available locally at `/legacy.html` with the development server. `npm start` still serves the old local backend on port 4747. It has no authentication and must remain local. Daymark's cloud UI does not use it as shared state.

Existing `data/household.sqlite`, phone Preferences keys, bundle ID, and unrelated uncommitted changes are preserved. Household settings offer explicit import of phone records or a SQLite JSON export as **legacy references**, without replaying approvals, creating calendar events, or sending drafts.

```sh
npm run legacy:export -- data/household.sqlite /private/tmp/daymark-legacy.json
```

The export reads the original database without modifying it, refuses to overwrite an existing export, and creates a private file. Import the file only after sign-in. Raw captures and old completion claims are not imported.

## Code map

- `web/src/`: Daymark UI, legacy interface, native adapters, local draft outbox.
- `shared/`: reusable calendar, approval, and validation rules.
- `convex/`: scoped records, jobs, Workflow orchestration, OAuth/provider adapters, private files and cleanup.
- `server/`: preserved Hono/SQLite prototype; standalone model-provider boundary and read-only legacy export.
- `ios/`: Capacitor app, Keychain bridge, and local Share-extension handoff.
- `tests/`: synthetic fixtures and repeatable browser scenarios.

Legacy meetings remain disabled unless `WREN_LEGACY=1`; legacy messaging remains a simulator.
