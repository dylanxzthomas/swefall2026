# Daymark development

- Start with README.md for current status and next action, then docs/MVP_BUILD_SPEC.md for requirements. Archived documents are historical, not current instructions.
- Keep one build spec. Update it in place when scope or architecture changes; do not create numbered work orders, ticket-like phases, duplicate plans, or new handoff documents.
- Keep README status brief: what works, what is next, and a material blocker if present. Update after meaningful progress, not every tool call.
- Add a few plain dated CHANGELOG.md bullets for meaningful completed behavior changes or decisions, with relevant verification. No per-file, per-test, or per-session diary.
- Keep changes small and coherent. Commit/PR descriptions state the result and verification. Put detailed test output in CI artifacts, not new Markdown reports. Do not commit or push solely to maintain documentation.
- Preserve the existing layout: UI in web/src, pure rules in shared, new backend in convex, native code in ios. Use ordinary feature names. Add directories only when working code needs them.
- Keep module tests near their code; shared end-to-end scenarios can live in tests. Verify changed behavior and material failure paths; avoid redundant tests for reversible cosmetic edits.
- Preserve existing data and unrelated uncommitted work. Mark mocks, disconnected services, and unverified native behavior honestly. Do not represent a drafted or queued action as completed.
- Store no secrets or private family data in commits, logs, screenshots, or test fixtures. Use isolated test accounts for external integration checks.
- Read-only research does not justify adding a dependency. Add a service only when the current MVP needs it, and explain the tradeoff in the existing spec.
