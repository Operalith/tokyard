# Security

TokYard 0.1 is alpha software. Only the latest alpha receives fixes; it has not undergone an independent security audit.

For a vulnerability, use the repository's **Security → Report a vulnerability** option when available. Do not put exploitable details, credentials or private data in public issues. If private reporting is unavailable, open a minimal issue requesting a private contact without disclosing the vulnerability.

Protect the host, `DATA_DIR`, backups, provider credentials and signing key. Use HTTPS for remote access, secure cookies and strong passwords. Treat owner sessions, owner Gateway keys and configured owner SSO identities as administrative credentials. Member keys must always use the metered endpoints.

The server stores provider credentials using inherited 9router storage. TokYard does not claim that every provider secret is encrypted at rest. Optional detailed request logs can contain prompt and response content; leave `ENABLE_REQUEST_LOGS=false` unless needed and protect any resulting logs. Credential headers are redacted in request diagnostics.

See the README for accounting boundaries, restore procedure and unsupported deployment modes.
