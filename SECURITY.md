# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Yuvomi, please report it responsibly. **Do not open a public issue.**

Instead, use [GitHub Private Vulnerability Reporting](https://github.com/ulsklyc/yuvomi/security/advisories/new) to submit your report. This creates a private advisory visible only to you and the maintainers.

Include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if you have one)

You should receive an acknowledgment within 48 hours. Fixes for confirmed vulnerabilities will be released as soon as possible.

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
- Passwords hashed with bcrypt v6 (cost factor 12)
- Login rate limiting (5 attempts/min per IP)
- API rate limiting (300 requests/min per IP)
- Content Security Policy via Helmet (`self`-only)
- Optional SQLCipher AES-256 database encryption (built into the official Docker image; enable by setting `DB_ENCRYPTION_KEY`. Bare-metal installs require a SQLCipher-enabled build of better-sqlite3.)
- Existing WebDAV documents protect their connection configuration: changing the URL, username, password, or base path requires explicit admin confirmation and a successful read test against an existing object; required connection data cannot be removed while WebDAV documents exist
- UI-managed WebDAV document-storage URLs are protected against SSRF: private, loopback, link-local, internal-DNS, and DNS-rebinding targets are rejected before persistence and during socket lookup. Trusted private-network targets require the deployment-controlled `DOCUMENT_STORAGE_WEBDAV_URL` override
- No API endpoint accessible without session auth (except login)
- `SESSION_SECRET` is mandatory - server refuses to start if unset

## Authorization Model

Yuvomi uses a flat family authorization model:

- **Admin** can create, edit, and delete all user accounts and all shared data.
- **Member** can read and write all shared data (tasks, shopping lists, meals, calendar events, notes, contacts, budget entries) but cannot manage user accounts.

There is no per-user data isolation - all family members see and can edit all data. This is intentional: Yuvomi is a shared family planner, not a multi-tenant application.

## Supported Versions

Only the latest version on `main` receives security updates. There are no LTS branches.
