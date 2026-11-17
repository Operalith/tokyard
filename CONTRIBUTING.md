# Contributing to TokYard

Open an issue for a bug or a focused pull request for a change. Explain the resulting behavior and relevant validation. Never include provider credentials, user API keys, signing keys, private prompts or database files.

Use Node.js 24, `npm ci`, and an isolated `DATA_DIR`. Start development with `npm run dev`. Before a pull request, run `npm test`, `npm run test:upstream`, `npm run build` and `npm run test:smoke`.

Keep the provider translation pipeline intact. Changes under `open-sse/` must follow its `AGENTS.md`. Token reservation, settlement and ownership checks must fail closed; quota writes must never depend on best-effort analytics. Include a focused regression check for changes to these paths.

The alpha supports one server instance. Discuss shared-database deployments, new payment flows, migrations or authorization changes before expanding scope. Preserve upstream MIT attribution.
