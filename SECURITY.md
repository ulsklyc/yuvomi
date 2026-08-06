# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Yuvomi, please report it responsibly. **Do not open a public issue.**

Instead, use [GitHub Private Vulnerability Reporting](https://github.com/ulsklyc/yuvomi/security/advisories/new) to submit your report. This creates a private advisory visible only to you and the maintainers.

Include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if you have one)

You should typically receive an acknowledgment within a few days (this is a solo-maintained project). Fixes for confirmed vulnerabilities will be released as soon as possible.

## Scope

Yuvomi is designed for self-hosted deployment on a private network behind a reverse proxy with SSL. The security model assumes:

- The server is not directly exposed to the public internet without Nginx + TLS
- The admin controls all user accounts (no public registration)
- The host machine itself is reasonably secured

Vulnerabilities that require physical access to the host or root on the server are generally out of scope.

## Security Features

- Session-based auth with `httpOnly`, `SameSite=Lax`, `Secure` cookies
  (Lax instead of Strict because Safari Intelligent Tracking Prevention
  blocks Strict cookies on reverse-proxy navigations and direct URL entry,
  which would cause 401 errors on login. CSRF risk is mitigated by the
  Double Submit Cookie pattern listed below and the `Secure` flag.)
- CSRF protection via Double Submit Cookie on all state-changing requests
- Passwords hashed with bcrypt v6 (cost factor 12). Passwords are Unicode-normalized to NFC before hashing and verification, so non-ASCII characters (umlauts, accents) authenticate identically regardless of how the browser normalizes the input. Hashes created before this normalization are still accepted and are silently re-hashed to NFC on the next successful login
- Invite links store only a SHA-256 hash of the token, never the token itself, so a leaked database cannot be turned into working invitations. They expire after 7 days, are single-use, and can be revoked at any time. Redemption happens in the same transaction that creates the user, so one token can never produce two accounts. Role and family role are taken from the invitation the admin created and are ignored in the redeeming request, so an invited member cannot make themselves an admin. The two public invite routes are rate-limited
- Login rate limiting (5 attempts/min per IP)
- API rate limiting (300 requests/min per IP)
- Content Security Policy via Helmet (`self`-only)
- Optional SQLCipher AES-256 database encryption, enabled by setting `DB_ENCRYPTION_KEY`. The cipher ships inside the `better-sqlite3-multiple-ciphers` binding, so Docker and bare-metal installs are covered alike and no system SQLCipher is required. If the key is set but encryption is unavailable, or the file on disk is still plaintext, the app refuses to start instead of silently storing data unencrypted. An existing unencrypted database is migrated once on startup, leaving a `*.plaintext-backup` copy behind that you should delete after verifying the migration
- Existing WebDAV documents protect their connection configuration: changing the URL, username, password, or base path requires explicit admin confirmation and a successful read test against an existing object; required connection data cannot be removed while WebDAV documents exist
- UI-managed WebDAV document-storage URLs are protected against SSRF: private, loopback, link-local, internal-DNS, and DNS-rebinding targets are rejected before persistence and during socket lookup. Trusted private-network targets require the deployment-controlled `DOCUMENT_STORAGE_WEBDAV_URL` override
- Google Drive document storage requests only `drive.file`, creates no public permissions, and uses a Drive-specific redirect URI, session OAuth state and `document_storage_google_drive_*` token namespace. Calendar token and state records are never reused or broadened
- Drive OAuth tokens, codes, folder IDs and raw Google responses are never returned by the API or intentionally logged. Disconnect deletes local Drive state without calling Google's revocation endpoint, so shared Calendar credentials are not revoked
- Reconnection validates the candidate account and access to an existing Drive-backed file before atomically replacing working tokens. Disconnect is blocked while Drive is selected or referenced by documents; connecting Drive never activates it for uploads
- The Outlook push requests only `Calendars.ReadWrite`, `User.Read` and `offline_access` as delegated scopes, against Microsoft's `/consumers` endpoint, so the grant covers personal Microsoft accounts and no mail, contacts or files. The OAuth handshake carries a 32-byte random state held in the session, and the callback is refused if it does not match. Every account-management route is admin-only; the sync-target list that all members read returns display names and calendar keys only, never credentials
- Outlook access and refresh tokens live per account row and are never returned by the API or intentionally logged - the account listing selects an explicit column set that excludes them. As with Drive, disconnecting deletes the local tokens without calling a revocation endpoint, so the grant survives at Microsoft until it is withdrawn under `account.live.com/consent/Manage`. Already-pushed events are deliberately left in the remote calendar rather than deleted by a disconnect
- The Outlook push is one-way by construction: no code path writes Graph event content into local events, and pushed events keep `external_source='local'`. Yuvomi reads back only calendar metadata and the `id`/`changeKey` of the events it created itself, so a compromised or edited remote calendar cannot inject content into the household's data
- Subscription logo discovery is SSRF-protected: only public HTTPS targets are fetched, every redirect is re-validated, and remote image responses are size/type constrained
- No API endpoint is accessible without session auth, apart from the entry points that are unauthenticated by design: login and first-run setup, the OIDC handshake (`/oidc/config`, `/oidc/start`, `/oidc/callback`), self-service password reset (`/forgot-password`, `/reset-password`), invitation preview and acceptance, and the per-user ICS export feed, which authenticates with its own secret token instead of a session. Every one of them except the feed carries a dedicated rate limiter on top of the global API limit; the feed is polled by calendar clients on a schedule and is covered by the global limit alone
- `SESSION_SECRET` is mandatory - server refuses to start if unset

## Authorization Model

Yuvomi uses a flat family authorization model:

- **Admin** can create, edit, and delete all user accounts and all shared data.
- **Member** can read and write all shared data (tasks, shopping lists, meals, calendar events, notes, contacts, budget entries) but cannot manage user accounts.

There is no per-user data isolation - all family members see and can edit all data. This is intentional: Yuvomi is a shared family planner, not a multi-tenant application.

## Supported Versions

Only the latest version on `main` receives security updates. There are no LTS branches.
