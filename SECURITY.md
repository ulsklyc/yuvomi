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

- Session-based auth with `httpOnly`, `SameSite=Strict`, `Secure` cookies
- CSRF protection via Double Submit Cookie on all state-changing requests
- Passwords hashed with bcrypt v6 (cost factor 12)
- Login rate limiting (5 attempts/min per IP)
- API rate limiting (300 requests/min per IP)
- Content Security Policy via Helmet (`self`-only)
- Optional SQLCipher AES-256 database encryption
- No API endpoint accessible without session auth (except login)
- `SESSION_SECRET` is mandatory - server refuses to start if unset

## Authorization Model

Yuvomi uses a flat family authorization model:

- **Admin** can create, edit, and delete all user accounts and all shared data.
- **Member** can read and write all shared data (tasks, shopping lists, meals, calendar events, notes, contacts, budget entries) but cannot manage user accounts.

There is no per-user data isolation - all family members see and can edit all data. This is intentional: Yuvomi is a shared family planner, not a multi-tenant application.

## Supported Versions

Only the latest version on `main` receives security updates. There are no LTS branches.
