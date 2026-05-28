# Security Research Report

> **Status overview:** Issues marked ✅ have been addressed in a subsequent release. Open issues are marked 🔓.



## 1. WAF IP-Spoofing & Global Rate Limiting Denial of Service (DoS)

**Location:** `server/index.js` (line 84)

**Description:**
Express is configured to trust exactly one proxy hop by default:
`app.set('trust proxy', process.env.TRUST_PROXY !== undefined ? process.env.TRUST_PROXY : 1);`

Because the application is placed behind a WAF, there are likely at least two proxy layers (e.g., WAF -> Nginx/Caddy -> Node.js Express).
By trusting only 1 proxy, Express drops the actual client IP and treats the WAF's IP address as the origin for all traffic.
If just one user triggers the rate limiter (`apiLimiter`, 300 req/min), the API blocks all users globally because they all appear to share the WAF's IP address.
Additionally, an attacker could craft custom `X-Forwarded-For` headers to manipulate the IPs, bypassing the rate limiter or spoofing their origin.

**Recommendation:**
Explicitly define `TRUST_PROXY=2` (or higher) in `.env` to ensure Express correctly extracts the real client IP.

## 2. Server-Side Request Forgery (SSRF) in ICS Subscriptions

**Location:** `server/services/ics-subscription.js`

**Description:**
The application allows users to supply URLs for calendar subscriptions. It implements a custom `checkSSRF` function to block internal networks. However, there are two flaws:
A. **Missing `0.0.0.0` and IPv6 localhost filtering:** The regex list fails to block `0.0.0.0` or `::`. Routing traffic to `0.0.0.0` bypasses the filter and resolves directly to `localhost` on Unix systems, allowing access to internal endpoints.
B. **DNS Rebinding Vulnerability:** The function uses a Time-of-Check to Time-of-Use (TOCTOU) anti-pattern. It resolves the hostname and verifies the IP, then passes the URL to `node-fetch`, which performs a second DNS resolution. An attacker can supply a domain with a DNS TTL of 0. The first resolution returns a public IP, and the second returns a private IP.

**Recommendation:**
- Add `/^0\.0\.0\.0$/` and `/^::$/` to the `PRIVATE_RANGES` array.
- To defeat DNS rebinding natively, Node's `fetch` should be given a custom `http.Agent` that forces it to connect to the exact IP address resolved during the initial `checkSSRF` verification.

## 3. Server-Side Request Forgery (SSRF) in CalDAV and CardDAV Sync

**Location:** 
- `server/services/caldav-sync.js` (`testConnection` and `addAccount`)
- `server/services/cardav-sync.js` (`testConnection` and `addAccount`)

**Description:**
Both the CalDAV and CardDAV services allow administrators to provide custom server URLs (`caldavUrl`, `carddavUrl`). These URLs are passed directly to `tsdav`'s `createDAVClient` to fetch calendars and address books. Unlike the ICS Subscription feature, these URLs are **not validated** against any internal network restrictions (no `checkSSRF` equivalent).
Since the app allows providing both a custom URL and custom credentials (Basic Auth), an attacker who compromises an admin account can supply internal IPs (e.g., `http://127.0.0.1:1234`, `http://169.254.169.254`) and force the server to send `PROPFIND` or `GET` requests with attacker-controlled Basic Auth headers to internal network services.

**Recommendation:**
- Implement strict SSRF filtering (similar to the fixed `checkSSRF`) for the URLs provided to `createDAVClient`. 
- Only allow safe schemes (`https://`) and explicitly deny routing traffic to internal IP ranges, including mitigating DNS rebinding.

## 4. Horizontal Privilege Escalation (IDOR) in Notes, Tasks, Meals, Contacts, and Calendar

**Location:** 
- `server/routes/notes.js` (`PUT`, `PATCH`, `DELETE`)
- `server/routes/tasks.js` (`PUT`, `PATCH`, `DELETE`)
- `server/routes/meals.js` (`PUT`, `DELETE`)
- `server/routes/calendar.js` (`PUT`, `DELETE`)
- `server/routes/contacts.js` (`PUT`, `DELETE`)

**Description:**
Update and delete operations for these modules lack ownership or authorization checks. Any authenticated user can modify or delete resources created by any other user in the system. While this may be partially intended for a "shared family" experience, it creates a risk of accidental or malicious data loss and modification. The inconsistency with other modules (like `recipes.js` and `documents.js`) that *do* implement ownership checks suggests these are oversights.

**Recommendation:**
Implement consistent authorization checks. Ensure only the creator or an administrator can modify or delete a resource, or explicitly define a shared access model with appropriate guardrails.

## 5. ✅ Vertical Privilege Escalation in Global Preferences — FIXED in v0.53.0

**Location:** `server/routes/preferences.js` (`PUT /api/v1/preferences`)

**Description:**
The endpoint to update global household preferences (currency, date format, application name, enabled modules, and dashboard widgets) is protected by authentication but **not by administrator roles**. Any user, including those with a standard user role, can change these settings for the entire household or disable entire application modules (e.g., Budget or Documents) for all users.

**Recommendation:**
Add the `requireAdmin` middleware to the `PUT /api/v1/preferences` route to ensure only administrators can modify global configuration.

**Fix (v0.53.0):** `PUT /api/v1/preferences` now enforces an admin role check before processing `disabled_modules`. Non-admin users receive a 403 response, preventing household-wide module changes. Additionally, `disableFailedThirdPartyModule` now attempts the API call first; on a 403 (non-admin user) the module remains visible in navigation rather than being silently removed.

## 6. Information Leak via Reminders IDOR

**Location:** `server/routes/reminders.js` (`POST /api/v1/reminders` and `GET /api/v1/reminders/pending`)

**Description:**
A user can create a reminder for any `entity_id` (Task or Event) without the system verifying if they have permission to view that entity. When fällige (due) reminders are retrieved via `/api/v1/reminders/pending`, the API joins with the `tasks` or `calendar_events` tables to return the `entity_title`. This allows an attacker to discover the titles of private tasks or events created by other users by iterating through entity IDs.

**Recommendation:**
Verify that the `created_by` of the reminder has access to the underlying `task` or `event` during both creation and retrieval.

## 7. Cross-User Data Leakage in Autocomplete Suggestions

**Location:** `server/routes/meals.js` (`GET /api/v1/meals/suggestions`)

**Description:**
The meal suggestions endpoint returns distinct meal titles from the entire database based on a prefix search, regardless of who created the meal entry. This exposes the meal planning history of all family members to any user, which may leak private information.

**Recommendation:**
Filter suggestions to only include entries created by the current user or those marked as shared/family-wide.

