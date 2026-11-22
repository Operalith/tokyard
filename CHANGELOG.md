# Changelog

## 0.1.0-alpha.3 — 2026-11-22

- Let members change their own password from My workspace after entering the current password and confirming the new one.
- Invalidate all of that member's dashboard sessions after a change, while preserving API keys, usage and access settings.
- Add a separate password-change attempt limit and protect against stale sessions, concurrent changes, cross-origin requests and changes to another member's account.
- Return members to the Member sign-in form with a password-change confirmation.

## 0.1.0-alpha.2 — 2026-11-22

- Add opt-in Usage only profiles: track each member's daily/monthly tokens across their API keys without enforcing personal or shared token budgets. Preserve saved limits, earlier usage and held requests when switching modes.
- Add optional daily token allowances, personal overrides and shared daily/monthly profile pools.
- Choose allowed models from active connections with search, saved-selection preservation and retry support.
- Apply profile allowance increases immediately and explain insufficient balances with used, held and required tokens.
- Isolate TokYard cookies from 9router and separate owner/member login lockouts.
- Preserve metered output caps through provider translation and retain uncertain upstream usage for reconciliation.
- Fix upgrades from older databases without workspace tables; add an additive upgrade for usage-only profiles while retaining existing limits.
- Replace external donation links with Bitcoin support: mainnet address, verified QR, clipboard action and wallet link.
- Fix sidebar Profiles/Activity navigation, active states and browser history.
- Restore Token Saver access and add an owner tools directory for inherited gateway features.
- Show the actual database location, refresh visible branding and SAML defaults, and explain the alpha backup limitation.
- Add browser regression checks for desktop/mobile navigation, Token Saver persistence and member access.
- Keep every TokYard file in its own data directory (`DATA_DIR`, else `~/.tokyard`) and default the CLI to port 20120; MITM, updater, runtime and CLI files no longer go to `~/.9router`.

## 0.1.0-alpha.1

- Establish TokYard as an independent MIT fork of 9router under Operalith.
- Add users, profiles, hashed member API keys, monthly token reservations and durable accounting.
- Separate owner/member access, enforce metered endpoint restrictions, and keep unknown usage held for reconciliation.
- Introduce the Workspace dashboard, personal member view, sign-in page, jade theme and optional donation destination.
- Disable upstream self-updates, tracking and incomplete JSON backups; add focused CI checks and setup documentation.

TokYard remains an alpha. See README for provider accounting and deployment boundaries.
