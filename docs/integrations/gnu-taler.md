# GNU Taler Settlement Integration — Architecture & Privacy Design

**Status:** Design proposal / grant planning document. No integration code exists yet.
**Scope of this document:** the *settlement layer only* — turning an already-computed debt
between two household members into a real, privacy-preserving payment, and writing that payment
back into Yuvomi's existing ledger once (and only once) it is confirmed.
**Audience:** NGI TALER reviewers and Yuvomi maintainers.

> **Reading note on uncertainty.** Yuvomi's data model below is verified against the current
> source tree (table and column names taken from `server/db.js` and `docs/SPEC.md`). Claims about
> the *GNU Taler merchant API* — endpoint names, contract-term field names, order/refund
> lifecycle, webhook shape — are based on general knowledge of Taler and **must be re-verified
> against the current Taler merchant backend documentation before implementation.** Every such
> claim is marked **[VERIFY]**. Where we are unsure, we say so rather than guess.

---

## 1. Problem statement and scope

### 1.1 What Yuvomi does today

Yuvomi is a self-hosted family-planner PWA. Its split-expense / budget module records shared
expenses and computes who owes whom. The relevant data model (already implemented) is:

- **`expenses`** — immutable expense records; amounts in integer minor units
  (`amount_minor`), with a `payer_id`, a `split_method`, and a currency.
- **`expense_splits`** — per-member share of each expense (`expense_id`, `user_id`,
  `amount_minor`).
- **`expense_ledger_entries`** — an immutable double-entry ledger. Every expense and every
  settlement produces signed rows here (`source_type ∈ {expense, expense_reversal, settlement,
  settlement_reversal}`, `user_id`, `counterparty_id`, signed `amount_minor`). **Balances are not
  stored** — they are aggregated live from this table.
- **`settlements`** + **`settlement_entries`** — records of a debt being paid off
  (`payer_id`, `payee_id`, `amount_minor`, `currency`, optional `proof_document_id`).

Balances and the minimal set of transfers are computed in `GET /groups/:id/balances`
(`server/routes/split-expenses.js`), which aggregates `expense_ledger_entries` and runs
`simplifyDebts()` to produce the minimal transfer set.

### 1.2 The gap

Today, *recording a payment is entirely manual and trust-based.* The only write path is
`POST /groups/:id/settlements` (`server/routes/split-expenses.js`, the settlement handler). In a
single `db.transaction()` it atomically:

1. inserts a row into `settlements`,
2. inserts a row into `settlement_entries`,
3. inserts **two** `expense_ledger_entries` rows with `source_type='settlement'` — `+amount_minor`
   for the payer and `−amount_minor` for the payee — and
4. logs an `expense_activity` event (`payment_registered`).

Step 3 — the ledger write — happens *immediately and synchronously* when someone clicks "mark as
settled." Nothing verifies that money actually moved. One member asserts "I paid Anna €20" and the
balance updates.

### 1.3 What this integration adds

We want an *optional* settlement rail where the debtor can actually pay the creditor with GNU
Taler, and the ledger entry is written **only after the payment is cryptographically confirmed**.
The core architectural change is to move step 3 above out of the synchronous request and behind a
payment-status state machine: **synchronous manual booking → asynchronous, payment-confirmed
booking.**

### 1.4 Explicit non-goals

- **Yuvomi does not become a payment provider, a wallet, or an exchange.** It never holds, routes,
  or custodies funds. It orchestrates a payment request and listens for confirmation.
- **We do not replace the existing manual settlement.** Manual "mark as settled" remains the
  default and the fallback. Taler is an additional, opt-in rail.
- **We do not modify the existing ledger semantics.** A Taler-backed settlement produces the exact
  same `expense_ledger_entries` rows as a manual one; it just gates them on confirmation.
- **Reference implementation, not a product.** Yuvomi serves as a concrete, auditable reference
  implementation of privacy-preserving household settlement on top of GNU Taler — useful to the
  wider self-hosted ecosystem — not as a hosted service.

---

## 2. Architecture options and recommendation

A Taler payment involves three components ([VERIFY] against current Taler architecture docs):

- **Wallet** — runs on the *payer's* device (browser extension / phone app). Holds digital coins,
  withdraws them from an exchange, and spends them.
- **Exchange** — the operator that issues and redeems digital cash, holds the reserve, and settles
  to real bank accounts. Heavyweight, regulated, and **not something a family self-hosts.** Each
  household connects to an existing exchange (e.g. a bank's or a community operator's).
- **Merchant backend** — a self-hostable service that creates *orders* (with *contract terms*),
  receives payment, and reports order status. This is the piece Yuvomi would integrate with.

The creditor (payee) needs to *receive* money. There are two fundamentally different ways to model
"member A pays member B" in Taler.

### Option A — Merchant-backend flow (creditor side runs/uses a merchant backend)

The creditor is modelled as a **merchant**. Yuvomi (on the creditor's instance) talks to a Taler
merchant backend, creates an order for the settlement amount, and the debtor's wallet pays that
order. Yuvomi polls/receives the order status and books the ledger entry on `paid`.

Two sub-variants of *where the merchant identity lives*:

- **A1 — per-payee merchant instance.** Each member who can receive money has their own merchant
  instance / account on the backend, bound to their own bank account. Clean separation of funds;
  money lands directly with the right person. More configuration per member.
- **A2 — per-household merchant instance.** One merchant instance for the whole household;
  internal attribution to the actual creditor is Yuvomi's responsibility. Simpler to configure,
  but money lands in *one* account and must be forwarded — which reintroduces a trust/custody
  problem we explicitly want to avoid, and may have regulatory implications. **[VERIFY]** whether a
  single merchant backend can cleanly host multiple independent payout accounts as separate
  instances (Taler merchant "instances" are designed for exactly this multi-tenant case, but the
  payout-account binding must be confirmed).

**Trade-offs (Option A):**

- *Self-hosting:* the merchant backend is self-hostable and relatively lightweight **[VERIFY:
  packaging/Docker availability and current resource footprint]**. The exchange is *not* self-hosted —
  this is the right division of labour: Yuvomi self-hosts the orchestration, an external exchange
  does the regulated heavy lifting.
- *Server-side payment verification:* **strong.** The merchant backend gives Yuvomi a first-class,
  authenticated way to ask "is order X paid?" and to receive webhooks. Confirmation is
  cryptographic and server-observable — exactly what we need to gate the ledger write. This is the
  decisive advantage.
- *Refunds:* the merchant API supports refunds **[VERIFY]**, which maps naturally onto our
  `settlement_reversal` ledger semantics.

### Option B — Peer-to-peer pull payment

Taler supports **peer-to-peer payments** directly between wallets, including *pull payments* where
the payee requests money and the payer's wallet fulfils the request, mediated by the exchange and
**without a merchant backend** **[VERIFY: that pull payments are GA in the current exchange/wallet
and the exact API surface]**.

**Trade-offs (Option B):**

- *Self-hosting:* lighter — no merchant backend to run. Appealing for minimal self-hosters.
- *Server-side payment verification:* **this is the problem.** A pull payment is fundamentally a
  *wallet-to-wallet* interaction. The creditor's *wallet* (on their device) learns the request was
  paid; it is not obvious that Yuvomi's *server* gets a trustworthy, authenticated confirmation
  signal without the creditor's wallet actively reporting back. That makes the "book only on
  confirmed payment" guarantee weaker or device-dependent. **[VERIFY]** whether the exchange exposes
  a server-consumable status for a pull-payment request that Yuvomi could poll with the creditor's
  authorization.
- *Requirement:* every receiving member needs a funded wallet; there is no bank-account payout
  path the way a merchant has.

### 2.3 Recommendation

**Adopt the merchant-backend flow (Option A) as the MVP spine, starting with A1 (per-payee
merchant instance).** Rationale:

1. It gives **server-observable, cryptographic payment confirmation**, which is the single hard
   requirement for safely gating the ledger write.
2. It keeps Yuvomi firmly out of custody: money flows debtor-wallet → exchange → creditor's own
   payout account.
3. Refund support maps onto our existing `settlement_reversal` ledger type.

**The per-payee (A1) vs per-household (A2) choice is named here as a funded design question, not
pre-decided.** A1 is privacy- and custody-cleaner; A2 is operationally simpler for a single shared
household account. The grant work (M1) includes a spike to resolve this against the real merchant
backend's multi-instance and payout-account model. Peer-to-peer pull payments (Option B) are
documented as a **future, lighter-weight rail** to revisit once server-side confirmation of a pull
payment is verified — they are out of scope for the MVP.

---

## 3. Privacy and threat model

The guiding principle: **Taler already minimises what the *payer* reveals (the exchange does not
learn who the buyer is — this is Taler's core "income-transparent, payer-anonymous" property
[VERIFY exact wording]). Yuvomi's job is to make sure *Yuvomi* leaks nothing extra* on top of that
— no names, no family structure, no expense line items.**

### 3.1 What each component can observe

| Component | Can observe | Cannot observe (by our design) |
|-----------|-------------|-------------------------------|
| **Wallet** (payer's device) | The contract terms it is asked to pay: an opaque settlement id, an amount, a currency, an expiry, and a generic summary string. | Who the creditor is by real name (we put no names in contract terms); the underlying expenses; other household members. |
| **Exchange** | That *some* wallet deposited coins of certain denominations to a given merchant/payout account, and the amount. By Taler's design it does **not** learn the payer's identity. **[VERIFY]** | Yuvomi's user identities, group structure, expense detail, the human meaning of the payment. |
| **Merchant backend** | The order: opaque settlement id, amount, currency, expiry, summary; that it was paid; the payout account. | Other household members; the expense breakdown; why the debt exists. The summary must be generic. |
| **Yuvomi server / DB** | Everything (it is the local source of truth) — but it stays on the self-hosted instance. | — |

### 3.2 Minimal contract terms

The **contract terms** Yuvomi sends to the merchant backend (and thus into the Taler world)
contain **only**:

- an **opaque settlement id** — a random token (e.g. a UUID/order id), never a sequential primary
  key, never anything derived from user or group ids;
- the **amount** (minor units / decimal as Taler requires **[VERIFY amount encoding]**);
- the **currency**;
- an **expiry** (`pay_deadline` / refund deadline **[VERIFY field names]**);
- a **generic, non-identifying summary** — e.g. a fixed localized string like *"Household
  settlement"*, **never** an expense title, member name, or category.

**Hard assertion: no names, no family structure, no expense titles, no categories, no group
names, and no per-line-item detail ever leave the local database.** The mapping from the opaque
settlement id back to the real payer/payee/expenses lives only in Yuvomi's own `taler_*` tables on
the self-hosted instance.

### 3.3 Threats and mitigations

| # | Threat | Mitigation |
|---|--------|-----------|
| T1 | **Metadata leak via contract terms** (names, expense detail, category reach the exchange/merchant). | Contract terms restricted to {opaque id, amount, currency, expiry, generic summary}. Enforced by a single serializer with no access to user/expense rows; covered by a test asserting the outbound payload contains no PII fields. |
| T2 | **Correlatable identifiers** (sequential order ids leak volume/links between settlements). | Random opaque settlement ids; no monotonic or user-derived ids in any Taler-facing field. |
| T3 | **Forged payment confirmation** — attacker calls the webhook claiming an unpaid order is paid, causing a bogus ledger entry. | Never trust the webhook body as proof. Treat the webhook as a *hint* and **re-verify** by polling the merchant backend's authenticated order-status endpoint server-side before booking (see §6). Authenticate the webhook (shared secret / signature) **[VERIFY webhook auth mechanism]**. |
| T4 | **Replay / double-booking** — same confirmation processed twice → duplicate ledger rows. | Idempotency on the opaque order id; a `UNIQUE` constraint and a one-way status state machine make the ledger write occur at most once (see §6). |
| T5 | **Secret theft from DB** (merchant API keys, payout config). | Secrets stored encrypted at rest; never returned by any API; masked in responses (mirrors the existing SMTP-password handling). Optional whole-DB encryption via `DB_ENCRYPTION_KEY`/SQLCipher. |
| T6 | **SSRF / malicious merchant URL** — admin (or an attacker) points the merchant base URL at an internal address. | Validate and, by default, block private/loopback/link-local targets for outbound merchant calls, mirroring Yuvomi's existing SSRF protections (document storage, subscription logo lookup), with an explicit opt-in env flag for trusted private networks. |
| T7 | **Tampered amount / currency** between debt computation and order creation. | The order amount is derived server-side from the computed balance at request time, not from client input; the booked ledger amount equals the *confirmed* order amount, not the requested one. |
| T8 | **Privacy regression over time** — a future change adds a field to contract terms. | The no-PII serializer test (T1) is a guardrail; any new outbound field must pass review. |

---

## 4. Proposed data model (`taler_*` tables)

New tables, added as **append-only migrations** to the `MIGRATIONS` array in `server/db.js`
(current highest version is 64, so these would be 65+). Naming and style follow the existing
expense tables (snake_case, integer minor units, `created_at` defaults via `strftime`). **No
existing table or migration is modified.**

### 4.1 `taler_merchant_accounts`

Per-payee (Option A1) or per-household (A2) merchant configuration. Secrets are stored encrypted
and never returned by the API.

| Column | Type | Constraint / notes |
|--------|------|--------------------|
| `id` | INTEGER | PK AUTOINCREMENT |
| `group_id` | INTEGER | FK → `expense_groups(id)` ON DELETE CASCADE, nullable (null = household-wide) |
| `payee_id` | INTEGER | FK → `users(id)` ON DELETE RESTRICT, nullable (set for A1 per-payee accounts) |
| `label` | TEXT | human label for the admin UI |
| `merchant_base_url` | TEXT | NOT NULL — merchant backend base URL (SSRF-validated) |
| `merchant_instance` | TEXT | NOT NULL — Taler merchant instance id **[VERIFY term]** |
| `api_key_encrypted` | TEXT | NOT NULL — encrypted merchant API token; never returned by API |
| `enabled` | INTEGER | NOT NULL DEFAULT 1 |
| `created_by` | INTEGER | FK → `users(id)` ON DELETE CASCADE |
| `created_at` | TEXT | NOT NULL DEFAULT now |
| `updated_at` | TEXT | NOT NULL DEFAULT now |

### 4.2 `taler_settlement_requests`

One row per attempt to settle a debt over Taler. This is the state machine that gates the ledger
write.

| Column | Type | Constraint / notes |
|--------|------|--------------------|
| `id` | INTEGER | PK AUTOINCREMENT |
| `group_id` | INTEGER | FK → `expense_groups(id)` ON DELETE CASCADE, NOT NULL |
| `account_id` | INTEGER | FK → `taler_merchant_accounts(id)` ON DELETE RESTRICT, NOT NULL |
| `payer_id` | INTEGER | FK → `users(id)` ON DELETE RESTRICT, NOT NULL (debtor) |
| `payee_id` | INTEGER | FK → `users(id)` ON DELETE RESTRICT, NOT NULL (creditor) |
| `amount_minor` | INTEGER | NOT NULL CHECK(> 0) |
| `currency` | TEXT | NOT NULL |
| `order_id` | TEXT | NOT NULL — **opaque** Taler order id; the idempotency key. UNIQUE. |
| `order_token` | TEXT | nullable — claim token from the merchant **[VERIFY]**; treated as a secret |
| `status` | TEXT | NOT NULL DEFAULT `'created'` CHECK in the set below |
| `pay_url` | TEXT | nullable — `taler://pay/…` URI presented to the debtor **[VERIFY scheme]** |
| `expires_at` | TEXT | nullable — order/pay deadline |
| `settlement_id` | INTEGER | FK → `settlements(id)` ON DELETE SET NULL, nullable — set **only** once booked |
| `last_error` | TEXT | nullable — last failure reason for the admin UI |
| `created_by` | INTEGER | FK → `users(id)` ON DELETE CASCADE, NOT NULL |
| `created_at` | TEXT | NOT NULL DEFAULT now |
| `updated_at` | TEXT | NOT NULL DEFAULT now |

**Status state machine:**

```
created ──▶ pending ──▶ paid ──▶ booked
   │           │          │
   │           │          └──▶ refunded        (after booked: payment returned)
   │           ├──▶ expired                     (pay deadline passed, unpaid)
   │           ├──▶ cancelled                   (user/admin aborted)
   │           └──▶ failed                      (merchant/exchange error)
   └──▶ cancelled
```

- `created` — row written, order not yet created at the merchant.
- `pending` — order created at the merchant; awaiting the debtor's wallet payment.
- `paid` — merchant confirms payment (server-verified, §6) but the ledger write has not yet
  committed.
- `booked` — terminal success: the `settlements` + `expense_ledger_entries` rows were written and
  `settlement_id` is set. **The ledger is touched only on this transition.**
- `expired` / `cancelled` / `failed` — terminal non-success; **no** ledger rows written.
- `refunded` — a previously `booked` settlement was refunded via Taler; triggers a
  `settlement_reversal` (see §6).

Only forward transitions in the diagram are legal; the state machine is enforced in code and the
`booked` transition is guarded by the idempotency constraint.

### 4.3 `taler_payment_events` (optional, recommended)

An append-only audit log of every status signal received (webhook or poll), for debugging and for
proving the booking decision after the fact.

| Column | Type | Constraint / notes |
|--------|------|--------------------|
| `id` | INTEGER | PK AUTOINCREMENT |
| `request_id` | INTEGER | FK → `taler_settlement_requests(id)` ON DELETE CASCADE, NOT NULL |
| `source` | TEXT | `'webhook'` or `'poll'` |
| `observed_status` | TEXT | raw status reported by the merchant |
| `payload_digest` | TEXT | hash of the verified payload (no raw PII stored) |
| `created_at` | TEXT | NOT NULL DEFAULT now |

---

## 5. Proposed API surface (routes only — no implementation)

All routes mounted under the existing split-expense router namespace, behind session auth + CSRF,
each handler in `try/catch`, `{ data: … }` response envelope (project convention). **Listed for
design review only.**

| Method & path | Purpose |
|---------------|---------|
| `POST /groups/:id/taler/settlements` | **Create a settlement request.** Body identifies payer, payee, amount (server re-derives from current balance), currency. Creates the `taler_settlement_requests` row (`created`), calls the merchant backend to create the order, returns the `pay_url` for the debtor. Idempotent on a client-supplied request key. |
| `GET /groups/:id/taler/settlements/:reqId` | **Get status.** Returns the current state-machine status and, if paid/booked, the linked `settlement_id`. May trigger a server-side re-poll of the merchant. |
| `POST /taler/webhook` | **Webhook receiver.** Authenticated endpoint the merchant backend calls on order status change. Treated as a *hint only*: it enqueues/triggers a server-side re-verification, never books directly from the body. **[VERIFY webhook capability and auth in current merchant API]** |
| `POST /groups/:id/taler/settlements/:reqId/cancel` | **Cancel** a `created`/`pending` request (best-effort cancel at the merchant; transitions to `cancelled`). No-op/refused once `booked`. |

Admin-only configuration routes for `taler_merchant_accounts` (create/list/update/delete, secrets
write-only and masked on read) live under the existing Settings → Administration area and follow
the same pattern as the SMTP/email admin routes. They are out of scope for this route list but
named here for completeness.

---

## 6. Reconciliation and idempotency strategy

The whole point of the integration is that **the ledger is written once, and only after confirmed
payment.** Concretely:

1. **Idempotent order ids.** The opaque `order_id` is generated once per settlement request and
   stored with a `UNIQUE` constraint. It is the idempotency key for both order creation at the
   merchant and booking in Yuvomi. Re-issuing "create order" for an existing request reuses the
   same `order_id` rather than creating a second order. **[VERIFY]** that the merchant API treats a
   repeated create with the same order id idempotently.

2. **Webhook is a hint, not proof (T3).** On `POST /taler/webhook`, Yuvomi does **not** book from
   the request body. It authenticates the call, records a `taler_payment_events` row, then performs
   a **server-side authenticated poll** of the merchant order-status endpoint **[VERIFY endpoint]**.
   Only a positive, server-observed `paid` status advances the state machine. Polling is also run
   on a scheduler as a backstop so a missed webhook still reconciles (mirrors the existing
   push/backup scheduler pattern).

3. **Book only on confirmed payment.** The transition `paid → booked` happens inside a single
   `db.transaction()` that:
   - re-reads the request row `FOR UPDATE`-style (SQLite: inside the transaction) and asserts its
     status is still `paid` and `settlement_id IS NULL` — if not, it is a no-op (dedupe);
   - writes the **same** rows the manual path writes today: one `settlements` row, one
     `settlement_entries` row, and the **two** signed `expense_ledger_entries` rows
     (`source_type='settlement'`, `+amount` / `−amount`);
   - sets `taler_settlement_requests.settlement_id` and status `booked`;
   - logs an `expense_activity` `payment_registered` event.

   Because `settlement_id IS NULL` is part of the guard and the status flips inside the same
   transaction, a duplicate confirmation (replay, T4) cannot produce a second settlement.

4. **Amount integrity (T7).** The booked `amount_minor` is the **confirmed** order amount from the
   merchant, compared against the request's stored amount; a mismatch fails the booking and moves
   the request to `failed` rather than booking a wrong number.

5. **Refunds.** A refund reported by the merchant on an already-`booked` request transitions it to
   `refunded` and writes a compensating `settlement_reversal` via the existing reversal ledger
   semantics — the ledger stays balanced without mutating historical rows.

6. **Manual fallback always available.** If Taler is not configured, the merchant is unreachable,
   or the user prefers it, the existing `POST /groups/:id/settlements` manual path is unchanged and
   remains the default. A Taler request that ends `expired`/`failed`/`cancelled` leaves the debt
   open and the user can settle manually. The two paths never both book the same debt because a
   manual settlement and a Taler booking each produce their own ledger rows; the UI surfaces an
   open Taler request to avoid double-paying, but the ledger is the single source of truth either
   way.

---

## 7. Milestones (M1–M5)

Mirrors the grant structure. Each milestone has concrete, checkable acceptance criteria.

### M1 — Design spike & path decision
Resolve the funded design questions against the **real** Taler merchant backend.
**Acceptance criteria:**
- A running self-hosted Taler merchant backend (sandbox/test exchange) is documented end to end.
- The **A1 (per-payee) vs A2 (per-household)** decision is made and written up, backed by what the
  merchant backend actually supports for multiple payout accounts/instances.
- Every **[VERIFY]** claim in this document is confirmed or corrected against current Taler docs,
  with the corrected facts recorded.
- A decision record on webhook availability + authentication and the exact order-status polling
  endpoint.

### M2 — Data model & configuration
**Acceptance criteria:**
- `taler_merchant_accounts`, `taler_settlement_requests`, (and `taler_payment_events`) added as
  append-only migrations (v65+), with the documented columns and the status `CHECK` constraint.
- Admin can configure a merchant account; the API key is stored **encrypted**, never returned, and
  masked on read (test-verified, mirroring SMTP-password handling).
- SSRF validation on `merchant_base_url` with an explicit private-network opt-in flag (test-verified).
- Test suite `test:taler-*` covering schema invariants and config redaction.

### M3 — Settlement flow (end to end) + accessibility
**Acceptance criteria:**
- `POST /groups/:id/taler/settlements` creates an order and returns a `pay_url`; a debtor can pay
  it with a real Taler wallet against the sandbox exchange and the request reaches `paid`.
- The `paid → booked` transition writes exactly the same ledger rows as the manual path and is
  idempotent under duplicate confirmation (test-verified, T4).
- No-PII serializer guard test passes: outbound contract terms contain only {opaque id, amount,
  currency, expiry, generic summary} (T1, T2).
- **WCAG 2.1 AA** is met for all new UI (the "pay with Taler" flow, status display, admin config):
  verified for keyboard operability, visible focus, contrast, labelled controls, and screen-reader
  announcement of payment status changes. This is an explicit, non-negotiable acceptance criterion
  for M3. New UI uses the project's `oikos-` web-component conventions, `t()` for all strings
  (all `public/locales/*.json` updated), no `innerHTML`, and design tokens only — no hardcoded
  colors/sizes.

### M4 — Reconciliation, webhooks & refunds
**Acceptance criteria:**
- Authenticated `POST /taler/webhook` triggers server-side re-verification (never books from the
  body); forged-webhook test (T3) does not produce a ledger row.
- Scheduler-based polling backstop reconciles a deliberately dropped webhook (test-verified).
- `expired`, `cancelled`, `failed` terminal states leave the debt open with no ledger write.
- A refund on a `booked` request produces a `settlement_reversal` and rebalances the ledger
  (test-verified).
- Cancel route behaves per state machine (refused after `booked`).

### M5 — Hardening, docs & reference-implementation release
**Acceptance criteria:**
- Threat-model items T1–T8 each have a corresponding passing test or documented mitigation.
- User docs (README, `docs/SPEC.md`, `docs/installation.md`, `.env.example`, installer) updated via
  the project's `/docs-sync`; any new env vars documented across all deploy targets.
- A "privacy for self-hosters" note explains exactly what does and does not leave the instance when
  Taler is enabled.
- The integration ships **disabled by default**, fully optional, with manual settlement unaffected
  when off.
- End-to-end walkthrough against a public Taler test exchange documented for reviewers to reproduce.

---

## 8. Open questions and risks

**Taler-specific (must be answered in M1, currently [VERIFY]):**
- Exact merchant API surface: order-creation endpoint, contract-term field names, amount encoding,
  order-status polling endpoint, and whether **webhooks/notifications** exist and how they are
  authenticated.
- Whether a single merchant backend can host **multiple independent payout accounts** as separate
  instances cleanly (decides A1 vs A2).
- Refund API shape and timing constraints (refund deadlines) and how they map to
  `settlement_reversal`.
- Whether **peer-to-peer pull payments** can give Yuvomi's *server* a trustworthy confirmation
  signal (decides whether Option B ever becomes viable).
- Precise wording of Taler's payer-anonymity / income-transparency properties, so our privacy
  claims in §3 are stated accurately rather than overstated.

**Product / ecosystem risks:**
- **Exchange availability.** Real settlements need an exchange the household actually has access to;
  in many regions that may only be a test exchange today. The feature's real-world usefulness
  tracks Taler exchange deployment, which is outside Yuvomi's control.
- **Wallet adoption.** Every paying member needs a Taler wallet installed. The manual fallback
  keeps the module fully usable for members who do not.
- **Multi-currency.** Yuvomi expenses are multi-currency; a Taler exchange operates in specific
  currencies. The settlement currency must match what the chosen exchange supports — the UI must
  prevent creating an order in an unsupported currency and fall back to manual settlement.
- **Regulatory.** The A2 (per-household pooled account) variant could imply forwarding others'
  money; this is a reason A1 is preferred. Any pooling needs legal review and is out of MVP scope.

**Risks we consider mitigated by design:**
- Custody/fraud at the Yuvomi layer — Yuvomi never holds funds.
- Double-booking and forged confirmations — handled by the idempotent state machine and
  server-side re-verification (§6).
- Metadata leakage — handled by the minimal-contract-terms rule and its guard test (§3).
