# Changelog

## Unreleased

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

This is an initial alpha. See README for provider accounting and deployment boundaries.
